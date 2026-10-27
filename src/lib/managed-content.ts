import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getFileType, sanitizeFilename } from "./files.ts";

type ReadObject = (key: string, range?: string, signal?: AbortSignal) => Promise<{
  body: ReadableStream<Uint8Array>;
  length?: number;
  contentRange?: string;
}>;

export function contentRange(header: string | null, size: number) {
  if (header === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) throw new Error("Invalid range.");
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) throw new Error("Invalid range.");
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) {
      throw new Error("Invalid range.");
    }
    end = Math.min(end, size - 1);
  }
  return { start, end, header: `bytes=${start}-${end}` };
}

function failure(status: number, headers: HeadersInit = {}) {
  return Response.json({ error: "This file is unavailable." }, {
    status, headers: { ...headers, "Cache-Control": "private, no-store, max-age=0" },
  });
}

export async function managedContent(
  request: Request,
  code: string,
  id: string,
  database: SupabaseClient,
  readObject: ReadObject,
) {
  const { data: file, error } = await database.from("files")
    .select("storage_key,storage_provider,original_name,content_type,size_bytes,spaces!inner(code,blocked_at)")
    .eq("id", id).eq("spaces.code", code).is("spaces.blocked_at", null)
    .eq("status", "ready").not("owner_token_hash", "is", null)
    .gt("expires_at", new Date().toISOString()).maybeSingle();
  if (error) return failure(503);
  if (!file || file.storage_provider !== "r2") return failure(404);
  const size = Number(file.size_bytes);
  if (!Number.isSafeInteger(size) || size < 1) return failure(503);
  let type: ReturnType<typeof getFileType>;
  try {
    type = getFileType(file.original_name);
    if (type.mime !== file.content_type) return failure(415);
  } catch {
    return failure(415);
  }
  const preview = new URL(request.url).searchParams.get("mode") === "preview";
  if (preview && !type.preview) return failure(415);
  let range: ReturnType<typeof contentRange>;
  try {
    range = contentRange(request.headers.get("range"), size);
  } catch {
    return failure(416, { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" });
  }
  try {
    const object = await readObject(file.storage_key, range?.header, request.signal);
    const length = range ? range.end - range.start + 1 : size;
    const expectedRange = range ? `bytes ${range.start}-${range.end}/${size}` : undefined;
    if (object.length !== length || object.contentRange !== expectedRange) {
      await object.body.cancel();
      return failure(503);
    }
    const filename = encodeURIComponent(sanitizeFilename(file.original_name))
      .replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16)}`);
    const headers: Record<string, string> = {
      "Cache-Control": "private, no-store, max-age=0",
      "Content-Type": type.mime,
      "Content-Length": String(length),
      "Content-Disposition": `${preview ? "inline" : "attachment"}; filename*=UTF-8''${filename}`,
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "SAMEORIGIN",
      "Content-Security-Policy": "sandbox allow-same-origin; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
      "Accept-Ranges": "bytes",
    };
    if (expectedRange) headers["Content-Range"] = expectedRange;
    return new Response(object.body, { status: range ? 206 : 200, headers });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "NoSuchKey" || name === "NotFound") return failure(404);
    if (name === "InvalidRange") return failure(416, { "Content-Range": `bytes */${size}` });
    return failure(503);
  }
}
