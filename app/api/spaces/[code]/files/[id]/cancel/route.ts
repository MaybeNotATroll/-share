import { z } from "zod";
import { spaceCodeSchema } from "@/src/lib/validation";
import { discardSmallRequestBody, enforceRateLimit, getSpace, jsonError, jsonNoStore } from "@/src/lib/http";
import { getSupabase } from "@/src/lib/supabase";
import { removeObjects } from "@/src/lib/storage";
import { activeFileCutoff } from "@/src/lib/file-lifetime";

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
      .select("storage_key,storage_provider")
      .eq("id", id)
      .eq("space_id", space.id)
      .eq("status", "pending")
      .gt("created_at", activeFileCutoff())
      .maybeSingle();
    if (file) {
      const { data: deleted, error } = await supabase.from("files").delete()
        .eq("id", id).eq("status", "pending").select("id");
      if (error) return jsonError("The upload could not be cancelled.", 503);
      if (deleted?.length) await removeObjects(file.storage_provider, [file.storage_key]);
    }
    return jsonNoStore({ cancelled: true });
  } catch {
    return jsonError("The upload could not be cancelled.", 503);
  }
}
