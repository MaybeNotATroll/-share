-- Existing objects remain in Supabase; only new reservations use R2.
alter table public.files
  add column storage_provider text not null default 'supabase'
  check (storage_provider in ('supabase', 'r2'));
alter table public.files alter column storage_provider set default 'r2';

alter table public.storage_cleanup_queue
  add column storage_provider text not null default 'supabase'
  check (storage_provider in ('supabase', 'r2'));
alter table public.storage_cleanup_queue alter column storage_provider set default 'r2';

create index files_expiration_idx on public.files (created_at);

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
    set cleanup_after = greatest(
      public.storage_cleanup_queue.cleanup_after, excluded.cleanup_after
    );
  return old;
end;
$$;

revoke all on function public.queue_deleted_file() from public, anon, authenticated;

create trigger files_queue_storage_cleanup
  before delete on public.files
  for each row execute function public.queue_deleted_file();
