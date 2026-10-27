import { z } from "zod";
import { spaceCodeSchema } from "@/src/lib/validation";
import { enforceRateLimit, getSpace, jsonError, jsonNoStore, matchesSecret, readJsonBody } from "@/src/lib/http";
import { getSupabase } from "@/src/lib/supabase";
import { removeObjects } from "@/src/lib/storage";

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
    const space = await getSpace(code, true);
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
      .select("storage_key,storage_provider")
      .eq("id", fileId)
      .eq("space_id", space.id)
      .maybeSingle();
    if (!file) return jsonError("This file is unavailable.", 404);
    const { error } = await supabase.from("files").delete().eq("id", fileId);
    if (error) return jsonError("The file could not be deleted.", 503);
    await removeObjects(file.storage_provider, [file.storage_key]);
    return jsonNoStore({ deleted: true });
  } catch {
    return jsonError("The moderation service is unavailable.", 503);
  }
}
