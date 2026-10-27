import { generatePrivateCode } from "@/src/lib/server-code";
import {
  databaseError,
  discardSmallRequestBody,
  enforceRateLimit,
  getSpace,
  jsonError,
  jsonNoStore,
  serviceError,
} from "@/src/lib/http";
import { getSupabase } from "@/src/lib/supabase";

export const runtime = "nodejs";

const MAX_ATTEMPTS = 10;

async function hasPostedContent(code: string): Promise<boolean> {
  const space = await getSpace(code, true);
  if (!space) return false;
  if (space.blocked_at) return true;
  const { count, error } = await getSupabase()
    .from("files")
    .select("id", { count: "exact", head: true })
    .eq("space_id", space.id);
  if (error) throw databaseError(error, "Files could not be checked.");
  return (count ?? 0) > 0;
}

export async function POST(request: Request) {
  try {
    if (!(await discardSmallRequestBody(request, 2048))) return jsonError("Request is too large.", 413);
    if (!(await enforceRateLimit(request, "generate", 10, 60))) {
      return jsonError("Too many numbers requested. Try again shortly.", 429);
    }

    // Keep drawing fresh random 100-digit codes until one has nothing posted under it.
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const code = generatePrivateCode();
      if (!(await hasPostedContent(code))) return jsonNoStore({ code });
    }
    return jsonError("An unused number could not be found. Please try again.", 503);
  } catch (error) {
    return serviceError(error);
  }
}
