import { jsonError, jsonNoStore, matchesSecret } from "@/src/lib/http";
import { getSupabase } from "@/src/lib/supabase";
import { cleanupFiles } from "@/src/lib/cleanup";
import { removeObjects } from "@/src/lib/storage";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  const authorization = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const secret = process.env.CRON_SECRET;
  if (!matchesSecret(authorization, secret)) return jsonError("Not authorized.", 401);

  try {
    const supabase = getSupabase();
    const result = await cleanupFiles(supabase, removeObjects);

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
    return jsonNoStore(result, result.hasMore || result.failedBatches ? 503 : 200);
  } catch {
    return jsonError("Cleanup could not be completed.", 503);
  }
}
