create extension if not exists pgcrypto;

create table public.spaces (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  visibility text not null check (visibility in ('public', 'private')),
  created_at timestamptz not null default now(),
  management_key_hash text,
  blocked_at timestamptz,
  storage_bytes bigint not null default 0 check (storage_bytes >= 0),
  file_count integer not null default 0 check (file_count >= 0),
  constraint spaces_code_format check (code ~ '^[0-9]{1,100}$'),
  constraint spaces_visibility_matches_code check (
    (visibility = 'public' and length(code) <= 20)
    or (visibility = 'private' and length(code) > 20)
  )
);

create index spaces_visibility_created_idx
  on public.spaces (visibility, created_at desc);

create table public.private_generation_requests (
  request_hash text primary key,
  created_at timestamptz not null default now(),
  space_id uuid references public.spaces(id) on delete set null
);

create index private_generation_requests_created_idx
  on public.private_generation_requests (created_at);

create table public.files (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces(id) on delete cascade,
  original_name text not null check (length(original_name) between 1 and 180),
  storage_key text not null unique,
  content_type text not null,
  size_bytes bigint not null check (size_bytes > 0),
  created_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'ready')),
  constraint files_storage_key_space check (storage_key like space_id::text || '/%')
);

create index files_space_created_idx
  on public.files (space_id, created_at desc, id desc)
  where status = 'ready';

create index files_pending_created_idx
  on public.files (created_at)
  where status = 'pending';

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces(id) on delete cascade,
  file_id uuid not null references public.files(id) on delete cascade,
  reason text not null check (reason in ('illegal', 'abuse', 'copyright', 'other')),
  created_at timestamptz not null default now()
);

create index reports_created_idx on public.reports (created_at desc);

create table public.rate_limits (
  key_hash text not null,
  window_start bigint not null,
  hit_count integer not null default 1,
  primary key (key_hash, window_start)
);

create table public.storage_cleanup_queue (
  storage_key text primary key,
  scheduled_at timestamptz not null default now(),
  cleanup_after timestamptz not null
);

create index storage_cleanup_due_idx on public.storage_cleanup_queue (cleanup_after);

alter table public.spaces enable row level security;
alter table public.files enable row level security;
alter table public.reports enable row level security;
alter table public.rate_limits enable row level security;
alter table public.private_generation_requests enable row level security;
alter table public.storage_cleanup_queue enable row level security;

revoke all on public.spaces, public.files, public.reports, public.rate_limits,
  public.private_generation_requests, public.storage_cleanup_queue
  from anon, authenticated;
grant all on public.spaces, public.files, public.reports, public.rate_limits,
  public.private_generation_requests, public.storage_cleanup_queue
  to service_role;

create or replace function public.check_rate_limit(
  p_key text,
  p_limit integer,
  p_window_seconds integer
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_window_start bigint;
  v_count integer;
begin
  if p_limit < 1 or p_window_seconds < 1 or length(p_key) > 128 then
    return false;
  end if;

  v_window_start :=
    floor(extract(epoch from clock_timestamp()) / p_window_seconds)::bigint
    * p_window_seconds;

  insert into public.rate_limits (key_hash, window_start, hit_count)
  values (p_key, v_window_start, 1)
  on conflict (key_hash, window_start)
  do update set hit_count = public.rate_limits.hit_count + 1
  returning hit_count into v_count;

  return v_count <= p_limit;
end;
$$;

revoke all on function public.check_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.check_rate_limit(text, integer, integer) to service_role;

create or replace function public.reserve_upload(
  p_space_id uuid,
  p_original_name text,
  p_storage_key text,
  p_content_type text,
  p_size_bytes bigint,
  p_max_file_bytes bigint,
  p_max_space_bytes bigint,
  p_max_files_per_space integer
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_space public.spaces%rowtype;
  v_file_id uuid;
begin
  if p_size_bytes < 1 or p_size_bytes > p_max_file_bytes then
    raise exception 'file_limit' using errcode = '22023';
  end if;

  select * into v_space
    from public.spaces
    where id = p_space_id and blocked_at is null
    for update;
  if not found then
    raise exception 'space_unavailable' using errcode = 'P0002';
  end if;

  if v_space.file_count >= p_max_files_per_space
    or v_space.storage_bytes + p_size_bytes > p_max_space_bytes then
    raise exception 'space_quota' using errcode = '54000';
  end if;

  update public.spaces
    set file_count = file_count + 1,
        storage_bytes = storage_bytes + p_size_bytes
    where id = p_space_id;

  insert into public.files (
    space_id, original_name, storage_key, content_type, size_bytes, status
  ) values (
    p_space_id, p_original_name, p_storage_key, p_content_type, p_size_bytes, 'pending'
  ) returning id into v_file_id;

  return v_file_id;
end;
$$;

revoke all on function public.reserve_upload(uuid, text, text, text, bigint, bigint, bigint, integer)
  from public, anon, authenticated;
grant execute on function public.reserve_upload(uuid, text, text, text, bigint, bigint, bigint, integer)
  to service_role;

create or replace function public.release_upload_quota()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.spaces
    set file_count = greatest(file_count - 1, 0),
        storage_bytes = greatest(storage_bytes - old.size_bytes, 0)
    where id = old.space_id;
  return old;
end;
$$;

create trigger files_release_quota
  after delete on public.files
  for each row execute function public.release_upload_quota();

insert into storage.buckets (
  id, name, public, file_size_limit, allowed_mime_types
) values (
  'share-files',
  'share-files',
  false,
  52428800,
  array[
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif',
    'video/mp4', 'video/webm', 'application/pdf', 'text/plain',
    'text/markdown', 'text/csv', 'application/json', 'application/rtf', 'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.oasis.opendocument.text',
    'application/vnd.oasis.opendocument.spreadsheet',
    'application/vnd.oasis.opendocument.presentation',
    'application/zip'
  ]
) on conflict (id) do update set
  public = false,
  file_size_limit = 52428800,
  allowed_mime_types = excluded.allowed_mime_types;

revoke all on storage.objects from anon, authenticated;
