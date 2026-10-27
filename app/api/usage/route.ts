import { dailyUploadUsage } from "@/src/lib/usage";
import { clientIpKey } from "@/src/lib/client-ip";
import { getSupabase } from "@/src/lib/supabase";
import { enforceRateLimit, jsonError, jsonNoStore, serviceError } from "@/src/lib/http";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    if (!(await enforceRateLimit(request, "usage", 120, 60))) return jsonError("Too many requests.", 429);
    return jsonNoStore(await dailyUploadUsage(getSupabase(), clientIpKey(request, "daily-upload")));
  } catch (error) {
    return serviceError(error);
  }
}
