import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { activeFileCutoff } from "./file-lifetime.ts";
import type { StorageProvider } from "./storage.ts";

type RemoveObjects = (provider: StorageProvider, keys: string[]) => Promise<void>;

export async function cleanupFiles(
  supabase: SupabaseClient,
  removeObjects: RemoveObjects,
  deadline = Date.now() + 45_000,
) {
  let removedFiles = 0;
  let failedBatches = 0;
  const cutoff = activeFileCutoff();
  // Metadata deletion atomically queues object keys and releases quota.
  while (Date.now() < deadline) {
    const { data: expired, error } = await supabase.from("files")
      .select("id").lte("created_at", cutoff)
      .order("created_at", { ascending: true }).limit(100);
    if (error) throw new Error("Cleanup unavailable.");
    if (!expired?.length) break;
    const { error: deleteError } = await supabase.from("files").delete()
      .in("id", expired.map((file) => file.id)).lte("created_at", cutoff);
    if (deleteError) throw new Error("Cleanup unavailable.");
    removedFiles += expired.length;
  }
  while (Date.now() < deadline) {
    const { data: queued, error } = await supabase.from("storage_cleanup_queue")
      .select("storage_key,storage_provider,cleanup_after")
      .lte("cleanup_after", new Date().toISOString())
      .order("cleanup_after", { ascending: true }).limit(100);
    if (error) throw new Error("Cleanup unavailable.");
    if (!queued?.length) return { removedFiles, hasMore: false, failedBatches };
    const keys = queued.map((item) => item.storage_key);
    // Older queue entries may still have metadata. Revoke access first.
    const { error: deleteError } = await supabase.from("files").delete().in("storage_key", keys);
    if (deleteError) throw new Error("Cleanup unavailable.");
    for (const provider of ["r2", "supabase"] as const) {
      const batch = queued.filter((item) => item.storage_provider === provider);
      if (!batch.length) continue;
      let failed = false;
      try {
        await removeObjects(provider, batch.map((item) => item.storage_key));
      } catch {
        failed = true;
        failedBatches++;
      }
      for (const item of batch) {
        // Back off a failed batch so one bad object cannot starve the queue.
        // Retrying already-deleted objects is safe for both providers.
        const query = supabase.from("storage_cleanup_queue");
        const mutation = failed
          ? query.update({ cleanup_after: new Date(Date.now() + 15 * 60 * 1000).toISOString() })
          : query.delete();
        const { error: queueError } = await mutation
          .eq("storage_key", item.storage_key).eq("cleanup_after", item.cleanup_after);
        if (queueError) throw new Error("Cleanup unavailable.");
      }
    }
    if (queued.some((item) => item.storage_provider !== "r2" && item.storage_provider !== "supabase")) {
      throw new Error("Cleanup unavailable.");
    }
  }
  return { removedFiles, hasMore: true, failedBatches };
}
