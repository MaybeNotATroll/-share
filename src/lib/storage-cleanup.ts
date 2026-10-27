import type { SupabaseClient } from "@supabase/supabase-js";

export async function queueStorageCleanup(
  supabase: SupabaseClient,
  storageKeys: string[],
): Promise<boolean> {
  if (storageKeys.length === 0) return true;
  const cleanupAfter = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
  const { error } = await supabase.from("storage_cleanup_queue").upsert(
    storageKeys.map((storageKey) => ({ storage_key: storageKey, cleanup_after: cleanupAfter })),
    { onConflict: "storage_key" },
  );
  return !error;
}
