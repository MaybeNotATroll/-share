import { z } from "zod";
import { spaceCodeSchema } from "@/src/lib/validation";
import { maxFileBytes, verifyFileSignature } from "@/src/lib/files";
import { discardSmallRequestBody, enforceRateLimit, getSpace, jsonError, jsonNoStore, serviceError } from "@/src/lib/http";
import { getSupabase } from "@/src/lib/supabase";
import { readUploadedHeader, removeObjects } from "@/src/lib/storage";
import { fileAccessSeconds } from "@/src/lib/file-lifetime";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ code: string; id: string }> },
) {
  try {
    if (!(await discardSmallRequestBody(request))) return jsonError("Request is too large.", 413);
    const { code, id } = await context.params;
    if (!spaceCodeSchema.safeParse(code).success || !z.string().uuid().safeParse(id).success) {
      return jsonError("The upload could not be completed.", 400);
    }
    if (!(await enforceRateLimit(request, "upload-complete", 30, 60))) {
      return jsonError("Too many requests. Try again shortly.", 429);
    }
    const space = await getSpace(code);
    if (!space) return jsonError("This space is unavailable.", 404);
    const supabase = getSupabase();
    const { data: file, error: fileError } = await supabase
      .from("files")
      .select("id,storage_key,size_bytes,content_type,status,original_name,created_at,expires_at,storage_provider,upload_ip_hash,upload_reservation_expires_at")
      .eq("id", id)
      .eq("space_id", space.id)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();
    if (fileError || !file || fileAccessSeconds(file.created_at, 60, Date.now(), file.expires_at) < 1) {
      return jsonError("The upload could not be completed.", 404);
    }
    if (file.status === "ready") return jsonNoStore({ completed: true });
    if (file.storage_provider !== "r2" || !file.upload_ip_hash) {
      return jsonError("Please cancel this older upload and upload the file again.", 409);
    }
    if (Date.parse(file.upload_reservation_expires_at) <= Date.now()) {
      await supabase.from("files").delete().eq("id", id).eq("status", "pending");
      return jsonError("The upload reservation expired. Please upload the file again.", 410);
    }
    const { bytes, size, contentType } = await readUploadedHeader(file.storage_key);
    const ext = file.original_name.split(".").pop()?.toLowerCase() ?? "";
    if (size !== Number(file.size_bytes) || size > maxFileBytes() ||
      contentType !== file.content_type || !verifyFileSignature(ext, bytes)) {
      const { error } = await supabase.from("files").delete().eq("id", id).eq("status", "pending");
      if (error) return jsonError("The file could not be validated. Please retry.", 503);
      await removeObjects("r2", [file.storage_key]);
      return jsonError("The file content did not pass validation.", 400);
    }
    const { data: updated, error: updateError } = await supabase
      .from("files")
      .update({ status: "ready" })
      .eq("id", id)
      .eq("space_id", space.id)
      .eq("status", "pending")
      .gt("expires_at", new Date().toISOString())
      .select("id");
    if (updateError?.code === "P0001" && updateError.message.includes("upload_reservation_expired")) {
      await supabase.from("files").delete().eq("id", id).eq("status", "pending");
      return jsonError("The upload reservation expired. Please upload the file again.", 410);
    }
    if (updateError) return jsonError("The upload could not be completed.", 503);
    if (!updated?.length) return jsonError("The upload is no longer available.", 404);
    return jsonNoStore({ completed: true });
  } catch (error) {
    return serviceError(error);
  }
}
