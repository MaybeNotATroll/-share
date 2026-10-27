import { deleteOwnerFile, readOwnerToken, sameOriginMutation } from "@/src/lib/owner";
import { getSupabase } from "@/src/lib/supabase";
import { removeObjects } from "@/src/lib/storage";
import { enforceRateLimit, jsonError, serviceError } from "@/src/lib/http";

export const runtime = "nodejs";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!readOwnerToken(request)) return jsonError("Owner session required.", 401);
  if (!sameOriginMutation(request)) return jsonError("Same-origin request required.", 403);
  try {
    if (!(await enforceRateLimit(request, "owner-delete", 60, 60))) return jsonError("Too many requests.", 429);
    return await deleteOwnerFile(request, (await context.params).id, getSupabase(), removeObjects);
  } catch (error) {
    return serviceError(error);
  }
}
