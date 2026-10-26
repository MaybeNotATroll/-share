import { z } from "zod";
import { getVisibility, spaceCodeSchema } from "@/src/lib/code";
import { enforceRateLimit, getSpace, jsonError, jsonNoStore } from "@/src/lib/http";
import { getSupabase, STORAGE_BUCKET } from "@/src/lib/supabase";

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
    const space = await getSpace(code, getVisibility(code) === "public");
    if (!space) return jsonError("This file is unavailable.", 404);

    const supabase = getSupabase();
    const { data: file, error } = await supabase
      .from("files")
      .select("id,storage_key,original_name,content_type,status")
      .eq("id", id)
      .eq("space_id", space.id)
      .eq("status", "ready")
      .maybeSingle();
    if (error || !file) return jsonError("This file is unavailable.", 404);
    if (mode === "preview" && !["image/", "video/", "application/pdf"].some((prefix) =>
      file.content_type.startsWith(prefix)
    )) {
      return jsonError("Preview is not available for this file type.", 415);
    }

    const { data: signed, error: signError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(file.storage_key, 60, {
        download: mode === "download" ? file.original_name : undefined,
      });
    if (signError || !signed) return jsonError("This file is temporarily unavailable.", 503);
    return jsonNoStore({ url: signed.signedUrl, expiresIn: 60 });
  } catch {
    return jsonError("The service is temporarily unavailable. Please try again.", 503);
  }
}
