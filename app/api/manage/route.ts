import { createHash } from "node:crypto";
import { z } from "zod";
import { getVisibility, spaceCodeSchema } from "@/src/lib/code";
import { enforceRateLimit, getSpace, jsonError, jsonNoStore, matchesSecret } from "@/src/lib/http";
import { getSupabase, STORAGE_BUCKET } from "@/src/lib/supabase";

export const runtime = "nodejs";

const requestSchema = z.object({
  code: spaceCodeSchema,
  credential: z.string().min(32).max(256),
  action: z.enum(["delete-file", "delete-space"]),
  fileId: z.string().uuid().optional(),
});

export async function POST(request: Request) {
  try {
    if (!(await enforceRateLimit(request, "manage", 6, 60))) {
      return jsonError("Too many management requests. Try again shortly.", 429);
    }
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return jsonError("Management request is invalid.", 400);
    }
    const parsed = requestSchema.safeParse(payload);
    if (!parsed.success) return jsonError("Management request is invalid.", 400);
    const { code, credential, action, fileId } = parsed.data;
    if (action === "delete-file" && !fileId) return jsonError("Choose a file to delete.", 400);

    const space = await getSpace(code);
    if (!space || space.visibility !== "private") {
      return jsonError("The management credential is not valid.", 403);
    }
    const candidateHash = createHash("sha256").update(credential).digest("hex");
    if (!matchesSecret(candidateHash, space.management_key_hash)) {
      return jsonError("The management credential is not valid.", 403);
    }

    const supabase = getSupabase();
    if (action === "delete-file" && fileId) {
      const { data: file, error } = await supabase
        .from("files")
        .select("storage_key")
        .eq("id", fileId)
        .eq("space_id", space.id)
        .maybeSingle();
      if (error || !file) return jsonError("This file is unavailable.", 404);
      const { error: storageError } = await supabase.storage
        .from(STORAGE_BUCKET)
        .remove([file.storage_key]);
      if (storageError) return jsonError("The file could not be deleted. Try again.", 503);
      const { error: deleteError } = await supabase
        .from("files")
        .delete()
        .eq("id", fileId)
        .eq("space_id", space.id);
      if (deleteError) return jsonError("The file could not be deleted. Try again.", 503);
      return jsonNoStore({ deleted: true });
    }

    const { data: files, error: filesError } = await supabase
      .from("files")
      .select("storage_key")
      .eq("space_id", space.id)
      .limit(1001);
    if (filesError || (files?.length ?? 0) > 1000) {
      return jsonError("The space could not be deleted. Contact support.", 503);
    }
    if (files?.length) {
      const { error: storageError } = await supabase.storage
        .from(STORAGE_BUCKET)
        .remove(files.map((file) => file.storage_key));
      if (storageError) return jsonError("The space could not be deleted. Try again.", 503);
    }
    const { error: deleteError } = await supabase.from("spaces").delete().eq("id", space.id);
    if (deleteError) return jsonError("The space could not be deleted. Try again.", 503);
    return jsonNoStore({ deleted: true });
  } catch {
    return jsonError("The service is temporarily unavailable. Please try again.", 503);
  }
}
