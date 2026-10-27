import {
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ServiceSetupError } from "./service-setup-error.ts";
import { getSupabase, STORAGE_BUCKET } from "./supabase.ts";

export const R2_BUCKET = "number-share-files";
export type StorageProvider = "r2" | "supabase";

export function getR2Client() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !/^[a-f0-9]{32}$/i.test(accountId) || !accessKeyId || !secretAccessKey) {
    throw new ServiceSetupError("Object storage is not configured.");
  }
  return new S3Client({
    region: "auto",
    forcePathStyle: true,
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

export async function createUploadUrl(key: string, size: number, contentType: string) {
  return getSignedUrl(getR2Client(), new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    ContentLength: size,
    ContentType: contentType,
    IfNoneMatch: "*",
  }), {
    expiresIn: 300,
    signableHeaders: new Set(["content-length", "content-type", "if-none-match"]),
  });
}

export async function readUploadedHeader(key: string) {
  const response = await getR2Client().send(new GetObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Range: "bytes=0-511",
  }));
  const range = response.ContentRange?.match(/^bytes 0-(\d+)\/(\d+)$/);
  if (!range || !response.Body || Number(range[1]) > 511 || (response.ContentLength ?? 513) > 512) {
    if (response.Body && "destroy" in response.Body) response.Body.destroy();
    throw new Error("Object could not be verified.");
  }
  const bytes = await response.Body.transformToByteArray();
  if (bytes.length > 512) throw new Error("Object could not be verified.");
  return {
    bytes,
    size: Number(range[2]),
    contentType: response.ContentType?.split(";")[0].trim().toLowerCase() ?? "",
  };
}

export async function createDownloadUrl(
  provider: StorageProvider,
  key: string,
  filename: string,
  download: boolean,
  seconds: number,
) {
  if (seconds < 1) throw new Error("File expired.");
  if (provider === "supabase") {
    const { data, error } = await getSupabase().storage.from(STORAGE_BUCKET)
      .createSignedUrl(key, seconds, { download: download ? filename : undefined });
    if (error || !data) throw new Error("Object unavailable.");
    return data.signedUrl;
  }
  if (provider !== "r2") throw new Error("Unknown storage provider.");
  return getSignedUrl(getR2Client(), new GetObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    ResponseCacheControl: "private, no-store, max-age=0",
    ResponseContentDisposition: `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16)}`)}`,
  }), { expiresIn: seconds });
}

export async function readObjectStream(key: string, range?: string, signal?: AbortSignal) {
  const response = await getR2Client().send(new GetObjectCommand({
    Bucket: R2_BUCKET, Key: key, Range: range,
  }), { abortSignal: signal });
  if (!response.Body) throw new Error("Object unavailable.");
  return {
    body: response.Body.transformToWebStream(),
    length: response.ContentLength,
    contentRange: response.ContentRange,
  };
}

export async function removeObjects(provider: StorageProvider, keys: string[]) {
  if (keys.length === 0) return;
  if (provider === "supabase") {
    const { error } = await getSupabase().storage.from(STORAGE_BUCKET).remove(keys);
    if (error) throw new Error("Object removal failed.");
    return;
  }
  if (provider !== "r2") throw new Error("Unknown storage provider.");
  const result = await getR2Client().send(new DeleteObjectsCommand({
    Bucket: R2_BUCKET,
    Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
  }));
  if (result.Errors?.length) throw new Error("Object removal failed.");
}
import "server-only";
