-- Keep legacy writers safe during rollout; the new RPC explicitly selects R2.
alter table public.files
  add column storage_provider text not null default 'supabase'
  check (storage_provider in ('supabase', 'r2'));

alter table public.storage_cleanup_queue
  add column storage_provider text not null default 'supabase'
  check (storage_provider in ('supabase', 'r2'));

create index files_expiration_idx on public.files (created_at);

create or replace function public.reserve_r2_upload(
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
  v_file_id uuid;
begin
  v_file_id := public.reserve_upload(
    p_space_id, p_original_name, p_storage_key, p_content_type,
    p_size_bytes, p_max_file_bytes, p_max_space_bytes, p_max_files_per_space
  );
  update public.files set storage_provider = 'r2' where id = v_file_id;
  return v_file_id;
end;
$$;

revoke all on function public.reserve_r2_upload(uuid, text, text, text, bigint, bigint, bigint, integer)
  from public, anon, authenticated;
grant execute on function public.reserve_r2_upload(uuid, text, text, text, bigint, bigint, bigint, integer)
  to service_role;

-- The tombstone and quota release commit with metadata deletion. Never lose
-- an object key on a crash between database deletion and object deletion.
create or replace function public.queue_deleted_file()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.storage_cleanup_queue (storage_key, storage_provider, cleanup_after)
  values (
    old.storage_key,
    old.storage_provider,
    case when old.created_at <= clock_timestamp() - interval '24 hours'
      then clock_timestamp()
      else clock_timestamp() + case when old.storage_provider = 'supabase'
        then interval '3 hours' else interval '10 minutes' end
    end
  )
  on conflict (storage_key) do update
    set storage_provider = excluded.storage_provider,
    cleanup_after = greatest(
      public.storage_cleanup_queue.cleanup_after, excluded.cleanup_after
    );
  return old;
end;
$$;

revoke all on function public.queue_deleted_file() from public, anon, authenticated;

create trigger files_queue_storage_cleanup
  before delete on public.files
  for each row execute function public.queue_deleted_file();
