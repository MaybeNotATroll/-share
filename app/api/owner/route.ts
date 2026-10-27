import { listOwnerFiles, readOwnerToken } from "@/src/lib/owner";
import { getSupabase } from "@/src/lib/supabase";
import { enforceRateLimit, jsonError, serviceError } from "@/src/lib/http";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!readOwnerToken(request)) return jsonError("Owner session required.", 401);
  try {
    if (!(await enforceRateLimit(request, "owner-list", 120, 60))) return jsonError("Too many requests.", 429);
    return await listOwnerFiles(request, getSupabase());
  } catch (error) {
    return serviceError(error);
  }
}
