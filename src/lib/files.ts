import { z } from "zod";
import { FILE_TYPES } from "./file-types.ts";

export const MAX_FILENAME_LENGTH = 180;
export { FILE_TYPES };

export const uploadMetadataSchema = z.object({
  name: z.string().min(1).max(1024),
  size: z.number().int().positive(),
  type: z.string().max(150).optional().default(""),
});

export function sanitizeFilename(filename: string): string {
  const cleaned = filename
    .normalize("NFC")
    .replace(/[\\/\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[<>:"|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");

  return Array.from(cleaned).slice(0, MAX_FILENAME_LENGTH).join("").trim() || "shared-file";
}

export function getFileType(filename: string) {
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  const type = FILE_TYPES[extension];
  if (!type) throw new Error("This file type is not supported.");
  return { extension, ...type };
}

export function validTypeHint(hint: string, expected: string): boolean {
  return !hint || hint === "application/octet-stream" || hint === expected;
}

export function verifyFileSignature(extension: string, bytes: Uint8Array): boolean {
  const startsWith = (...signature: number[]) =>
    signature.every((value, index) => bytes[index] === value);
  const ascii = (start: number, end: number) =>
    String.fromCharCode(...bytes.slice(start, end));

  switch (extension) {
    case "jpg":
    case "jpeg":
      return startsWith(0xff, 0xd8, 0xff);
    case "png":
      return startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case "gif":
      return ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a";
    case "webp":
      return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
    case "avif":
      return ascii(4, 12).includes("ftypavif");
    case "mp4":
      return ascii(4, 8) === "ftyp";
    case "webm":
      return startsWith(0x1a, 0x45, 0xdf, 0xa3);
    case "pdf":
      return ascii(0, 5) === "%PDF-";
    case "rtf":
      return ascii(0, 5) === "{\\rtf";
    case "doc":
    case "xls":
    case "ppt":
      return startsWith(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
    case "docx":
    case "xlsx":
    case "pptx":
    case "odt":
    case "ods":
    case "odp":
    case "zip":
      return startsWith(0x50, 0x4b, 0x03, 0x04) || startsWith(0x50, 0x4b, 0x05, 0x06);
    case "txt":
    case "md":
    case "csv":
    case "json":
      return bytes.length > 0 && !bytes.includes(0);
    default:
      return false;
  }
}

export function maxFileBytes(): number {
  return 500_000_000;
}

export function maxFilesPerRequest(): number {
  const configured = Number(process.env.MAX_FILES_PER_REQUEST ?? 5);
  if (!Number.isSafeInteger(configured) || configured < 1 || configured > 5) return 5;
  return configured;
}

export function maxSpaceBytes(): number {
  const configured = Number(process.env.MAX_SPACE_BYTES ?? 1_073_741_824);
  if (!Number.isSafeInteger(configured) || configured < 1) return 1_073_741_824;
  return configured;
}

export function maxFilesPerSpace(): number {
  const configured = Number(process.env.MAX_FILES_PER_SPACE ?? 1000);
  if (!Number.isSafeInteger(configured) || configured < 1 || configured > 10_000) {
    return 1000;
  }
  return configured;
}

export function uploadRateLimit(): number {
  const configured = Number(process.env.UPLOAD_RATE_LIMIT ?? 12);
  return Number.isSafeInteger(configured) && configured >= 1 && configured <= 10_000 ? configured : 12;
}

export function uploadRateWindowSeconds(): number {
  const configured = Number(process.env.UPLOAD_RATE_WINDOW_SECONDS ?? 60);
  return Number.isSafeInteger(configured) && configured >= 1 && configured <= 86_400 ? configured : 60;
}
