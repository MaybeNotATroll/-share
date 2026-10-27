import { enforceRateLimit, jsonError, jsonNoStore, matchesSecret } from "@/src/lib/http";
import { getSupabase, STORAGE_BUCKET } from "@/src/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  const authorization = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const secret = process.env.CRON_SECRET ?? process.env.VERCEL_CRON_SECRET;
  if (!matchesSecret(authorization, secret)) return jsonError("Not authorized.", 401);

  try {
    const supabase = getSupabase();
    const expiredBefore = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: abandoned, error: listError } = await supabase
      .from("files")
      .select("id,storage_key")
      .eq("status", "pending")
      .lt("created_at", expiredBefore)
      .limit(500);
    if (listError) return jsonError("Cleanup could not be completed.", 503);

    let removedFiles = 0;
    for (let offset = 0; offset < (abandoned?.length ?? 0); offset += 100) {
      const batch = abandoned!.slice(offset, offset + 100);
      const { error: storageError } = await supabase.storage
        .from(STORAGE_BUCKET)
        .remove(batch.map((file) => file.storage_key));
      if (storageError) continue;
      const { error: deleteError } = await supabase
        .from("files")
        .delete()
        .in("id", batch.map((file) => file.id))
        .eq("status", "pending");
      if (!deleteError) removedFiles += batch.length;
    }

    const cleanupTime = new Date().toISOString();
    const { data: queued, error: queueError } = await supabase
      .from("storage_cleanup_queue")
      .select("storage_key")
      .lt("cleanup_after", cleanupTime)
      .limit(500);
    if (queueError) return jsonError("Cleanup could not be completed.", 503);
    for (let offset = 0; offset < (queued?.length ?? 0); offset += 100) {
      const batch = queued!.slice(offset, offset + 100);
      const storageKeys = batch.map((item) => item.storage_key);
      const { error: storageError } = await supabase.storage
        .from(STORAGE_BUCKET)
        .remove(storageKeys);
      if (storageError) continue;
      const { error: fileDeleteError } = await supabase
        .from("files")
        .delete()
        .in("storage_key", storageKeys);
      if (fileDeleteError) continue;
      await supabase.from("storage_cleanup_queue").delete().in("storage_key", storageKeys);
    }

    const oldWindow = Math.floor((Date.now() - 48 * 60 * 60 * 1000) / 1000);
    const { error: limitsError } = await supabase
      .from("rate_limits")
      .delete()
      .lt("window_start", oldWindow);
    const oldRequests = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { error: requestsError } = await supabase
      .from("private_generation_requests")
      .delete()
      .lt("created_at", oldRequests);
    if (limitsError || requestsError) return jsonError("Cleanup could not be completed.", 503);
    return jsonNoStore({ removedFiles });
  } catch {
    return jsonError("Cleanup could not be completed.", 503);
  }
}
