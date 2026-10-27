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
  uploadRateLimit,
  uploadRateWindowSeconds,
} from "@/src/lib/files";
import {
  enforceRateLimit,
  databaseError,
  getOrCreateSpace,
  getSpace,
  jsonError,
  jsonNoStore,
  readJsonBody,
  serviceError,
} from "@/src/lib/http";
import { getSupabase } from "@/src/lib/supabase";
import { createUploadUrl, getR2Client } from "@/src/lib/storage";
import { activeFileCutoff } from "@/src/lib/file-lifetime";
import { clientIpKey } from "@/src/lib/client-ip";
import { uploadQuotaMessage, type UploadQuota } from "@/src/lib/upload-quota";

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
      .gt("created_at", activeFileCutoff())
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
    if (!(await enforceRateLimit(request, "upload", uploadRateLimit(), uploadRateWindowSeconds()))) {
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

    getR2Client();
    const existing = await getSpace(code, true);
    if (existing?.blocked_at) return jsonError("This space is unavailable.", 404);
    if (!existing && !(await enforceRateLimit(request, "space-create", 20, 3600))) {
      return jsonError("Too many new spaces started. Try again later.", 429);
    }
    const space = existing ?? (await getOrCreateSpace(code));
    if (!space) return jsonError("This space is unavailable.", 404);

    const supabase = getSupabase();
    const ipHash = clientIpKey(request, "daily-upload");
    const reservations: { id: string; storageKey: string; uploadUrl: string; index: number }[] = [];
    const rejected: { index: number; error: string; quota: UploadQuota; reason: string }[] = [];
    for (const [index, file] of prepared.entries()) {
      const storageKey = `${space.id}/${randomUUID()}`;
      const { data: result, error: reserveError } = await supabase.rpc("reserve_r2_upload", {
        p_space_id: space.id,
        p_original_name: file.name,
        p_storage_key: storageKey,
        p_content_type: file.mime,
        p_size_bytes: file.input.size,
        p_max_file_bytes: maxFileBytes(),
        p_max_space_bytes: maxSpaceBytes(),
        p_max_files_per_space: maxFilesPerSpace(),
        p_ip_hash: ipHash,
      });
      if (!reserveError && result?.error && result?.quota) {
        const quota = result.quota as UploadQuota;
        rejected.push({
          index,
          reason: result.error,
          quota,
          error: result.error === "daily_upload_limit"
            ? uploadQuotaMessage(quota)
            : "Other uploads are using your remaining daily allowance. Wait for them to finish or cancel, or retry after their ten-minute reservations expire.",
        });
        continue;
      }
      const fileId = result?.id;
      if (reserveError || typeof fileId !== "string") {
        for (const reserved of reservations) {
          await supabase.from("files").delete().eq("id", reserved.id).eq("status", "pending");
        }
        if (reserveError && !["54000", "22023"].includes(reserveError.code)) {
          throw databaseError(reserveError, "An upload could not be reserved.");
        }
        const quota = reserveError?.code === "54000" || reserveError?.code === "22023";
        return jsonError(
          quota ? "This space has reached its upload limit." : "An upload could not be reserved.",
          quota ? 413 : 503,
        );
      }

      try {
        const uploadUrl = await createUploadUrl(storageKey, file.input.size, file.mime);
        reservations.push({ id: fileId, storageKey, uploadUrl, index });
      } catch {
        await supabase.from("files").delete().eq("id", fileId).eq("status", "pending");
        for (const reserved of reservations) {
          await supabase.from("files").delete().eq("id", reserved.id).eq("status", "pending");
        }
        return jsonError("An upload could not be started. Please try again.", 503);
      }
    }

    if (!reservations.length && rejected.length) {
      return jsonNoStore({ ...rejected[0], rejected, uploads: [] },
        rejected[0].reason === "daily_upload_limit" ? 413 : 409);
    }
    return jsonNoStore({
      rejected,
      uploads: reservations.map((reservation) => ({
        id: reservation.id,
        index: reservation.index,
        uploadUrl: reservation.uploadUrl,
        name: prepared[reservation.index].name,
        contentType: prepared[reservation.index].mime,
        size: prepared[reservation.index].input.size,
        headers: { "If-None-Match": "*" },
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
