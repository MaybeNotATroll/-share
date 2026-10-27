create table public.daily_upload_usage (
  ip_hash text not null check (ip_hash ~ '^[a-f0-9]{64}$'),
  day date not null,
  uploaded_bytes bigint not null default 0
    check (uploaded_bytes between 0 and 500000000),
  primary key (ip_hash, day)
);

create index daily_upload_usage_day_idx on public.daily_upload_usage (day);

alter table public.daily_upload_usage enable row level security;
revoke all on public.daily_upload_usage from public, anon, authenticated;
grant all on public.daily_upload_usage to service_role;

alter table public.files
  add column upload_ip_hash text check (upload_ip_hash ~ '^[a-f0-9]{64}$'),
  add column upload_reservation_expires_at timestamptz;

create index files_active_ip_reservations_idx
  on public.files (upload_ip_hash, upload_reservation_expires_at)
  where status = 'pending';

-- Old application instances must fail closed instead of issuing unmetered URLs.
drop function public.reserve_r2_upload(uuid, text, text, text, bigint, bigint, bigint, integer);

create function public.reserve_r2_upload(
  p_space_id uuid,
  p_original_name text,
  p_storage_key text,
  p_content_type text,
  p_size_bytes bigint,
  p_max_file_bytes bigint,
  p_max_space_bytes bigint,
  p_max_files_per_space integer,
  p_ip_hash text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz;
  v_day date;
  v_used bigint;
  v_reserved bigint;
  v_file_id uuid;
  v_details jsonb;
begin
  if p_ip_hash is null or p_ip_hash !~ '^[a-f0-9]{64}$'
    or p_size_bytes is null or p_size_bytes < 1 or p_size_bytes > p_max_file_bytes then
    raise exception 'invalid_upload' using errcode = '22023';
  end if;

  -- Shared across spaces and UTC days, including completions around midnight.
  perform pg_advisory_xact_lock(hashtextextended(p_ip_hash, 0));
  v_now := clock_timestamp();
  v_day := (v_now at time zone 'UTC')::date;
  select uploaded_bytes into v_used from public.daily_upload_usage
    where ip_hash = p_ip_hash and day = v_day;
  v_used := coalesce(v_used, 0);
  select coalesce(sum(size_bytes), 0) into v_reserved from public.files
    where upload_ip_hash = p_ip_hash and status = 'pending'
      and upload_reservation_expires_at > v_now;

  v_details := jsonb_build_object(
    'limitBytes', 500000000,
    'uploadedBytes', v_used,
    'fileBytes', p_size_bytes,
    'wouldTotalBytes', v_used + p_size_bytes,
    'overLimitBytes', greatest(v_used + p_size_bytes - 500000000, 0),
    'remainingBytes', 500000000 - v_used,
    'reservedBytes', v_reserved,
    'resetAt', (v_day + 1)::timestamp at time zone 'UTC'
  );
  if v_used + p_size_bytes > 500000000 then
    return jsonb_build_object('error', 'daily_upload_limit', 'quota', v_details);
  end if;
  if v_used + v_reserved + p_size_bytes > 500000000 then
    return jsonb_build_object('error', 'uploads_in_progress', 'quota', v_details);
  end if;

  v_file_id := public.reserve_upload(
    p_space_id, p_original_name, p_storage_key, p_content_type,
    p_size_bytes, p_max_file_bytes, p_max_space_bytes, p_max_files_per_space
  );
  update public.files set
    storage_provider = 'r2',
    upload_ip_hash = p_ip_hash,
    upload_reservation_expires_at = v_now + interval '10 minutes'
    where id = v_file_id;
  return jsonb_build_object('id', v_file_id);
end;
$$;

revoke all on function public.reserve_r2_upload(uuid, text, text, text, bigint, bigint, bigint, integer, text)
  from public, anon, authenticated;
grant execute on function public.reserve_r2_upload(uuid, text, text, text, bigint, bigint, bigint, integer, text)
  to service_role;

-- Validation happens in the API before this transition. The final usage and
-- publication commit together; retries, deletion, and moderation cannot refund it.
create function public.account_completed_upload()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz;
  v_day date;
  v_used bigint;
begin
  if old.status <> 'pending' or new.status <> 'ready' or old.upload_ip_hash is null then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(old.upload_ip_hash, 0));
  v_now := clock_timestamp();
  if old.upload_reservation_expires_at is null or old.upload_reservation_expires_at <= v_now then
    raise exception 'upload_reservation_expired' using errcode = 'P0001';
  end if;
  v_day := (v_now at time zone 'UTC')::date;
  insert into public.daily_upload_usage (ip_hash, day)
    values (old.upload_ip_hash, v_day) on conflict do nothing;
  select uploaded_bytes into v_used from public.daily_upload_usage
    where ip_hash = old.upload_ip_hash and day = v_day;
  if v_used + old.size_bytes > 500000000 then
    raise exception 'daily_upload_limit' using errcode = '54000';
  end if;
  update public.daily_upload_usage set uploaded_bytes = uploaded_bytes + old.size_bytes
    where ip_hash = old.upload_ip_hash and day = v_day;
  return new;
end;
$$;

revoke all on function public.account_completed_upload() from public, anon, authenticated;
create trigger files_account_completed_upload
  before update of status on public.files
  for each row execute function public.account_completed_upload();
