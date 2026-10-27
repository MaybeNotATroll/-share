-- Additive and rerunnable: never reassign ownership or extend existing expiry.
alter table public.files add column if not exists owner_token_hash text
  check (owner_token_hash ~ '^[a-f0-9]{64}$');
alter table public.files add column if not exists expires_at timestamptz;
update public.files set expires_at = created_at + interval '24 hours' where expires_at is null;
alter table public.files alter column expires_at set default (now() + interval '24 hours');
alter table public.files alter column expires_at set not null;

create index if not exists files_expires_at_idx on public.files (expires_at);
create index if not exists files_owner_created_idx
  on public.files (owner_token_hash, created_at desc, id desc) where status = 'ready';

create or replace function public.reserve_managed_r2_upload(
  p_space_id uuid, p_original_name text, p_storage_key text, p_content_type text,
  p_size_bytes bigint, p_max_file_bytes bigint, p_max_space_bytes bigint,
  p_max_files_per_space integer, p_ip_hash text, p_owner_token_hash text,
  p_expires_in_seconds integer default 86400
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
begin
  if p_owner_token_hash is null or p_owner_token_hash !~ '^[a-f0-9]{64}$'
    or p_expires_in_seconds is null or p_expires_in_seconds not in (3600, 21600, 43200, 86400) then
    raise exception 'invalid_managed_upload' using errcode = '22023';
  end if;
  -- Keep the existing per-IP advisory lock, reservation limits, and accounting.
  v_result := public.reserve_r2_upload(
    p_space_id, p_original_name, p_storage_key, p_content_type, p_size_bytes,
    p_max_file_bytes, p_max_space_bytes, p_max_files_per_space, p_ip_hash
  );
  if v_result ? 'id' then
    update public.files set owner_token_hash = p_owner_token_hash,
      expires_at = created_at + make_interval(secs => p_expires_in_seconds)
      where id = (v_result->>'id')::uuid;
  end if;
  return v_result;
end;
$$;
revoke all on function public.reserve_managed_r2_upload(uuid,text,text,text,bigint,bigint,bigint,integer,text,text,integer)
  from public, anon, authenticated;
grant execute on function public.reserve_managed_r2_upload(uuid,text,text,text,bigint,bigint,bigint,integer,text,text,integer)
  to service_role;

create or replace function public.enforce_managed_file_lifetime()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if old.owner_token_hash is not null and (
    new.owner_token_hash is distinct from old.owner_token_hash or new.expires_at > old.expires_at
  ) then
    raise exception 'managed_lifetime_immutable' using errcode = '22023';
  end if;
  if old.status = 'pending' and new.status = 'ready' and new.expires_at <= clock_timestamp() then
    raise exception 'file_expired' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_managed_file_lifetime() from public, anon, authenticated;
drop trigger if exists files_enforce_managed_lifetime on public.files;
create trigger files_enforce_managed_lifetime before update on public.files
  for each row execute function public.enforce_managed_file_lifetime();

create or replace function public.get_daily_upload_usage(p_ip_hash text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_now timestamptz;
  v_day date;
  v_used bigint;
  v_reserved bigint;
begin
  if p_ip_hash is null or p_ip_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid_ip_hash' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_ip_hash, 0));
  v_now := clock_timestamp();
  v_day := (v_now at time zone 'UTC')::date;
  select coalesce((select uploaded_bytes from public.daily_upload_usage
    where ip_hash = p_ip_hash and day = v_day), 0) into v_used;
  select coalesce(sum(size_bytes), 0) into v_reserved from public.files
    where upload_ip_hash = p_ip_hash and status = 'pending'
      and upload_reservation_expires_at > v_now;
  return jsonb_build_object('uploadedBytes', v_used, 'reservedBytes', v_reserved,
    'limitBytes', 500000000, 'resetAt', (v_day + 1)::timestamp at time zone 'UTC');
end;
$$;
revoke all on function public.get_daily_upload_usage(text) from public, anon, authenticated;
grant execute on function public.get_daily_upload_usage(text) to service_role;

create or replace function public.queue_deleted_file()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  insert into public.storage_cleanup_queue (storage_key, storage_provider, cleanup_after)
  values (old.storage_key, old.storage_provider,
    case
      -- A pending presigned PUT can finish after metadata revocation. Keep its
      -- tombstone past the PUT's validity plus a late-write grace period.
      when old.status = 'pending' then clock_timestamp() +
        case when old.storage_provider = 'supabase' then interval '3 hours' else interval '10 minutes' end
      when old.expires_at <= clock_timestamp() then clock_timestamp()
      when old.storage_provider = 'supabase' then clock_timestamp() + interval '3 hours'
      else clock_timestamp() + interval '10 minutes'
    end)
  on conflict (storage_key) do update set storage_provider = excluded.storage_provider,
    cleanup_after = greatest(public.storage_cleanup_queue.cleanup_after, excluded.cleanup_after);
  return old;
end;
$$;
revoke all on function public.queue_deleted_file() from public, anon, authenticated;
