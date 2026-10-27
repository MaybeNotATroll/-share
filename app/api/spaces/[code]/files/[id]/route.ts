import { z } from "zod";
import { spaceCodeSchema } from "@/src/lib/validation";
import { enforceRateLimit, getSpace, jsonError, jsonNoStore } from "@/src/lib/http";
import { getSupabase } from "@/src/lib/supabase";
import { createDownloadUrl } from "@/src/lib/storage";
import { activeFileCutoff, fileAccessSeconds } from "@/src/lib/file-lifetime";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ code: string; id: string }> },
) {
  try {
    const { code, id } = await context.params;
    if (!spaceCodeSchema.safeParse(code).success || !z.string().uuid().safeParse(id).success) {
      return jsonError("This file is unavailable.", 404);
    }
    if (!(await enforceRateLimit(request, "download", 120, 60))) {
      return jsonError("Too many requests. Try again shortly.", 429);
    }
    const mode = new URL(request.url).searchParams.get("mode") === "preview" ? "preview" : "download";
    const space = await getSpace(code);
    if (!space) return jsonError("This file is unavailable.", 404);

    const supabase = getSupabase();
    const { data: file, error } = await supabase
      .from("files")
      .select("id,storage_key,original_name,content_type,status,created_at,storage_provider")
      .eq("id", id)
      .eq("space_id", space.id)
      .eq("status", "ready")
      .gt("created_at", activeFileCutoff())
      .maybeSingle();
    if (error || !file) return jsonError("This file is unavailable.", 404);
    if (mode === "preview" && !["image/", "video/", "application/pdf"].some((prefix) =>
      file.content_type.startsWith(prefix)
    )) {
      return jsonError("Preview is not available for this file type.", 415);
    }

    const seconds = fileAccessSeconds(file.created_at);
    if (seconds < 1) return jsonError("This file is unavailable.", 404);
    const url = await createDownloadUrl(
      file.storage_provider, file.storage_key, file.original_name, mode === "download", seconds,
    );
    return jsonNoStore({ url, expiresIn: seconds });
  } catch {
    return jsonError("The service is temporarily unavailable. Please try again.", 503);
  }
}
