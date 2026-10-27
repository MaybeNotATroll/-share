import { z } from "zod";
import { getVisibility } from "@/src/lib/code";
import { spaceCodeSchema } from "@/src/lib/validation";
import { enforceRateLimit, getSpace, jsonError, jsonNoStore, matchesSecret, readJsonBody } from "@/src/lib/http";
import { getSupabase, STORAGE_BUCKET } from "@/src/lib/supabase";
import { queueStorageCleanup } from "@/src/lib/storage-cleanup";

export const runtime = "nodejs";

const moderationSchema = z.object({
  code: spaceCodeSchema,
  action: z.enum(["block-space", "delete-file"]),
  fileId: z.string().uuid().optional(),
});

export async function POST(request: Request) {
  try {
    if (!(await enforceRateLimit(request, "moderation", 30, 60))) {
      return jsonError("Too many requests. Try again shortly.", 429);
    }
    const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (!matchesSecret(token, process.env.MODERATION_TOKEN)) {
      return jsonError("Not authorized.", 401);
    }
    const body = await readJsonBody(request, 4096);
    if (!body.ok) return jsonError(body.tooLarge ? "Moderation request is too large." : "Moderation request is invalid.", body.tooLarge ? 413 : 400);
    const parsed = moderationSchema.safeParse(body.value);
    if (!parsed.success) return jsonError("Moderation request is invalid.", 400);
    const { code, action, fileId } = parsed.data;
    const space = await getSpace(code, false, true);
    if (!space) return jsonError("This space is unavailable.", 404);
    const supabase = getSupabase();

    if (action === "block-space") {
      const { error } = await supabase
        .from("spaces")
        .update({ blocked_at: new Date().toISOString() })
        .eq("id", space.id);
      if (error) return jsonError("The space could not be restricted.", 503);
      return jsonNoStore({ restricted: true });
    }

    if (!fileId) return jsonError("Choose a file to delete.", 400);
    const { data: file } = await supabase
      .from("files")
      .select("storage_key")
      .eq("id", fileId)
      .eq("space_id", space.id)
      .maybeSingle();
    if (!file) return jsonError("This file is unavailable.", 404);
    if (!(await queueStorageCleanup(supabase, [file.storage_key]))) {
      return jsonError("The file could not be deleted.", 503);
    }
    const { error: storageError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .remove([file.storage_key]);
    if (storageError) return jsonError("The file could not be deleted.", 503);
    const { error } = await supabase.from("files").delete().eq("id", fileId);
    if (error) return jsonError("The file could not be deleted.", 503);
    return jsonNoStore({ deleted: true });
  } catch {
    return jsonError("The moderation service is unavailable.", 503);
  }
}
