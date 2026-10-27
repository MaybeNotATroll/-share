import { z } from "zod";
import { spaceCodeSchema } from "@/src/lib/validation";
import { enforceRateLimit, getSpace, jsonError, jsonNoStore } from "@/src/lib/http";
import { getSupabase } from "@/src/lib/supabase";
import { createDownloadUrl } from "@/src/lib/storage";
import { fileAccessSeconds } from "@/src/lib/file-lifetime";
import { downloadLocation } from "@/src/lib/download-location";

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
      .select("id,storage_key,original_name,content_type,status,created_at,expires_at,storage_provider,owner_token_hash")
      .eq("id", id)
      .eq("space_id", space.id)
      .eq("status", "ready")
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();
    if (error || !file) return jsonError("This file is unavailable.", 404);
    if (mode === "preview" && !["image/", "video/", "application/pdf"].some((prefix) =>
      file.content_type.startsWith(prefix)
    )) {
      return jsonError("Preview is not available for this file type.", 415);
    }

    const seconds = fileAccessSeconds(file.created_at, 60, Date.now(), file.expires_at);
    if (seconds < 1) return jsonError("This file is unavailable.", 404);
    const url = await downloadLocation(file, code, id, mode === "preview", seconds, request.url, createDownloadUrl);
    return jsonNoStore({ url, expiresIn: seconds });
  } catch {
    return jsonError("The service is temporarily unavailable. Please try again.", 503);
  }
}
