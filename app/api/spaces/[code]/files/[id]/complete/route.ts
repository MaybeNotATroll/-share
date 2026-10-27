import { z } from "zod";
import { spaceCodeSchema } from "@/src/lib/validation";
import { verifyFileSignature } from "@/src/lib/files";
import { discardSmallRequestBody, enforceRateLimit, getSpace, jsonError, jsonNoStore } from "@/src/lib/http";
import { getSupabase, STORAGE_BUCKET } from "@/src/lib/supabase";
import { queueStorageCleanup } from "@/src/lib/storage-cleanup";

export const runtime = "nodejs";

async function readFileHeader(url: string) {
  const response = await fetch(url, {
    headers: { Range: "bytes=0-511" },
    cache: "no-store",
    redirect: "error",
  });
  if (response.status !== 206) {
    await response.body?.cancel();
    throw new Error("The uploaded file could not be verified.");
  }
  const range = response.headers.get("content-range")?.match(/^bytes 0-(\d+)\/(\d+)$/);
  if (!range) {
    await response.body?.cancel();
    throw new Error("The uploaded file could not be verified.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The uploaded file could not be verified.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (length < 512) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    const chunk = value.subarray(0, 512 - length);
    chunks.push(chunk);
    length += chunk.length;
    if (chunk.length !== value.length) {
      await reader.cancel();
      break;
    }
  }
  await reader.cancel().catch(() => undefined);
  return {
    bytes: Uint8Array.from(chunks.flatMap((chunk) => Array.from(chunk))),
    size: Number(range[2]),
    contentType: response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "",
  };
}

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
      .select("id,storage_key,size_bytes,content_type,status")
      .eq("id", id)
      .eq("space_id", space.id)
      .maybeSingle();
    if (fileError || !file || file.status !== "pending") {
      return jsonError("The upload could not be completed.", 404);
    }

    const { data: signed, error: signError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(file.storage_key, 60);
    if (signError || !signed) return jsonError("The uploaded file was not found.", 400);

    const { bytes, size, contentType } = await readFileHeader(signed.signedUrl);
    const { data: metadata, error: metadataError } = await supabase
      .from("files")
      .select("original_name")
      .eq("id", id)
      .single();
    const ext = metadata?.original_name.split(".").pop()?.toLowerCase() ?? "";
    if (
      metadataError ||
      size !== Number(file.size_bytes) ||
      contentType !== file.content_type ||
      !verifyFileSignature(ext, bytes)
    ) {
      if (!(await queueStorageCleanup(supabase, [file.storage_key]))) {
        return jsonError("The file could not be validated. Please retry.", 503);
      }
      const { error: storageError } = await supabase.storage.from(STORAGE_BUCKET).remove([file.storage_key]);
      if (storageError) return jsonError("The file could not be validated. Please retry.", 503);
      await supabase.from("files").delete().eq("id", id).eq("status", "pending");
      return jsonError("The file content did not pass validation.", 400);
    }

    const { error: updateError } = await supabase
      .from("files")
      .update({ status: "ready" })
      .eq("id", id)
      .eq("space_id", space.id)
      .eq("status", "pending");
    if (updateError) return jsonError("The upload could not be completed.", 503);
    return jsonNoStore({ completed: true });
  } catch {
    return jsonError("The upload could not be verified. Please retry or upload it again.", 400);
  }
}
