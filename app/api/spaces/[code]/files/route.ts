import { randomUUID } from "node:crypto";
import { z } from "zod";
import { spaceCodeSchema } from "@/src/lib/validation";
import {
  getFileType,
  maxFileBytes,
  maxFilesPerRequest,
  maxFilesPerSpace,
  maxSpaceBytes,
  sanitizeFilename,
  uploadMetadataSchema,
  validTypeHint,
} from "@/src/lib/files";
import {
  enforceRateLimit,
  getOrCreateSpace,
  getSpace,
  jsonError,
  jsonNoStore,
  readJsonBody,
  serviceError,
} from "@/src/lib/http";
import { getSupabase, STORAGE_BUCKET } from "@/src/lib/supabase";

export const runtime = "nodejs";

const requestSchema = z.object({
  files: z.array(uploadMetadataSchema).min(1).max(5),
});

export async function GET(
  request: Request,
  context: { params: Promise<{ code: string }> },
) {
  try {
    const { code } = await context.params;
    if (!spaceCodeSchema.safeParse(code).success) return jsonError("Enter a valid code.", 400);
    if (!(await enforceRateLimit(request, "list", 120, 60))) {
      return jsonError("Too many requests. Try again shortly.", 429);
    }
    const space = await getSpace(code, true);
    if (space?.blocked_at) return jsonError("This space is unavailable.", 404);
    if (!space) return jsonNoStore({ files: [], nextCursor: null });

    const url = new URL(request.url);
    const rawLimit = Number(url.searchParams.get("limit") ?? 24);
    const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 48) : 24;
    const cursor = url.searchParams.get("cursor");
    if (cursor && cursor.length > 512) return jsonError("The file-list cursor is invalid.", 400);
    let query = getSupabase()
      .from("files")
      .select("id,original_name,content_type,size_bytes,created_at")
      .eq("space_id", space.id)
      .eq("status", "ready")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit + 1);

    if (cursor) {
      let decoded: unknown;
      try {
        decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      } catch {
        return jsonError("The file-list cursor is invalid.", 400);
      }
      const parsed = z.object({
        createdAt: z.string().datetime({ offset: true }),
        id: z.string().uuid(),
      }).safeParse(decoded);
      if (!parsed.success) return jsonError("The file-list cursor is invalid.", 400);
      query = query.or(
        `created_at.lt.${parsed.data.createdAt},and(created_at.eq.${parsed.data.createdAt},id.lt.${parsed.data.id})`,
      );
    }

    const { data, error } = await query;
    if (error) return jsonError("Files could not be loaded. Please try again.", 503);
    const rows = data ?? [];
    const hasMore = rows.length > limit;
    const files = rows.slice(0, limit).map((file) => ({
      id: file.id,
      name: file.original_name,
      contentType: file.content_type,
      size: Number(file.size_bytes),
      createdAt: file.created_at,
    }));
    const last = files.at(-1);
    const nextCursor =
      hasMore && last
        ? Buffer.from(JSON.stringify({ createdAt: last.createdAt, id: last.id })).toString("base64url")
        : null;

    return jsonNoStore({ files, nextCursor });
  } catch (error) {
    return serviceError(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ code: string }> },
) {
  try {
    const { code } = await context.params;
    if (!spaceCodeSchema.safeParse(code).success) return jsonError("Enter a valid code.", 400);
    if (!(await enforceRateLimit(request, "upload", 12, 60))) {
      return jsonError("Too many uploads. Try again shortly.", 429);
    }

    const body = await readJsonBody(request, 16_384);
    if (!body.ok) return jsonError(body.tooLarge ? "Upload details are too large." : "Upload details are invalid.", body.tooLarge ? 413 : 400);
    const parsed = requestSchema.safeParse(body.value);
    if (!parsed.success || parsed.data.files.length > maxFilesPerRequest()) {
      return jsonError(`Choose up to ${maxFilesPerRequest()} files at a time.`, 400);
    }
    const prepared = parsed.data.files.map((input) => {
      const name = sanitizeFilename(input.name);
      const fileType = getFileType(name);
      if (!validTypeHint(input.type, fileType.mime)) {
        throw new Error("A file type does not match its filename.");
      }
      if (input.size > maxFileBytes()) throw new Error("A file exceeds the individual size limit.");
      return { input, name, ...fileType };
    });

    const existing = await getSpace(code, true);
    if (existing?.blocked_at) return jsonError("This space is unavailable.", 404);
    if (!existing && !(await enforceRateLimit(request, "space-create", 20, 3600))) {
      return jsonError("Too many new spaces started. Try again later.", 429);
    }
    const space = existing ?? (await getOrCreateSpace(code));
    if (!space) return jsonError("This space is unavailable.", 404);

    const supabase = getSupabase();
    const reservations: { id: string; storageKey: string; uploadUrl: string }[] = [];
    for (const file of prepared) {
      const storageKey = `${space.id}/${randomUUID()}`;
      const { data: fileId, error: reserveError } = await supabase.rpc("reserve_upload", {
        p_space_id: space.id,
        p_original_name: file.name,
        p_storage_key: storageKey,
        p_content_type: file.mime,
        p_size_bytes: file.input.size,
        p_max_file_bytes: maxFileBytes(),
        p_max_space_bytes: maxSpaceBytes(),
        p_max_files_per_space: maxFilesPerSpace(),
      });
      if (reserveError || typeof fileId !== "string") {
        for (const reserved of reservations) {
          await supabase.from("files").delete().eq("id", reserved.id);
        }
        const quota = reserveError?.code === "54000" || reserveError?.code === "22023";
        return jsonError(
          quota ? "This space has reached its upload limit." : "An upload could not be reserved.",
          quota ? 413 : 503,
        );
      }

      const { data: signed, error: signError } = await supabase.storage
        .from(STORAGE_BUCKET)
        .createSignedUploadUrl(storageKey, { upsert: false });
      if (signError || !signed) {
        await supabase.from("files").delete().eq("id", fileId);
        for (const reserved of reservations) {
          await supabase.from("files").delete().eq("id", reserved.id);
        }
        return jsonError("An upload could not be started. Please try again.", 503);
      }
      reservations.push({ id: fileId, storageKey, uploadUrl: signed.signedUrl });
    }

    return jsonNoStore({
      uploads: reservations.map((reservation, index) => ({
        id: reservation.id,
        uploadUrl: reservation.uploadUrl,
        name: prepared[index].name,
        contentType: prepared[index].mime,
        size: prepared[index].input.size,
      })),
    }, 201);
  } catch (error) {
    if (error instanceof Error && error.message.includes("filename")) {
      return jsonError("A file type does not match its filename.", 400);
    }
    if (error instanceof Error && error.message.includes("supported")) {
      return jsonError("One or more file types are not supported.", 400);
    }
    if (error instanceof Error && error.message.includes("individual size")) {
      return jsonError("A file exceeds the individual size limit.", 413);
    }
    return serviceError(error);
  }
}
