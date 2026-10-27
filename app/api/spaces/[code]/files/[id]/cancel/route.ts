import { z } from "zod";
import { spaceCodeSchema } from "@/src/lib/validation";
import { discardSmallRequestBody, enforceRateLimit, getSpace, jsonError, jsonNoStore } from "@/src/lib/http";
import { getSupabase, STORAGE_BUCKET } from "@/src/lib/supabase";
import { queueStorageCleanup } from "@/src/lib/storage-cleanup";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ code: string; id: string }> },
) {
  try {
    if (!(await discardSmallRequestBody(request))) return jsonError("Request is too large.", 413);
    const { code, id } = await context.params;
    if (!spaceCodeSchema.safeParse(code).success || !z.string().uuid().safeParse(id).success) {
      return jsonError("The upload could not be cancelled.", 400);
    }
    if (!(await enforceRateLimit(request, "upload-cancel", 30, 60))) {
      return jsonError("Too many requests. Try again shortly.", 429);
    }
    const space = await getSpace(code);
    if (!space) return jsonError("This space is unavailable.", 404);
    const supabase = getSupabase();
    const { data: file } = await supabase
      .from("files")
      .select("storage_key")
      .eq("id", id)
      .eq("space_id", space.id)
      .eq("status", "pending")
      .maybeSingle();
    if (file) {
      if (!(await queueStorageCleanup(supabase, [file.storage_key]))) {
        return jsonError("The upload could not be cancelled.", 503);
      }
      const { error: storageError } = await supabase.storage.from(STORAGE_BUCKET).remove([file.storage_key]);
      if (storageError) return jsonError("The upload could not be cancelled.", 503);
      await supabase.from("files").delete().eq("id", id).eq("status", "pending");
    }
    return jsonNoStore({ cancelled: true });
  } catch {
    return jsonError("The upload could not be cancelled.", 503);
  }
}
