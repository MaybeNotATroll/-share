import { z } from "zod";

export const MAX_FILENAME_LENGTH = 180;
export const FILE_TYPES: Record<string, { mime: string; preview: boolean }> = {
  jpg: { mime: "image/jpeg", preview: true },
  jpeg: { mime: "image/jpeg", preview: true },
  png: { mime: "image/png", preview: true },
  gif: { mime: "image/gif", preview: true },
  webp: { mime: "image/webp", preview: true },
  avif: { mime: "image/avif", preview: true },
  mp4: { mime: "video/mp4", preview: true },
  webm: { mime: "video/webm", preview: true },
  pdf: { mime: "application/pdf", preview: true },
  txt: { mime: "text/plain", preview: false },
  md: { mime: "text/markdown", preview: false },
  csv: { mime: "text/csv", preview: false },
  json: { mime: "application/json", preview: false },
  doc: { mime: "application/msword", preview: false },
  docx: {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    preview: false,
  },
  xls: { mime: "application/vnd.ms-excel", preview: false },
  xlsx: {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    preview: false,
  },
  ppt: { mime: "application/vnd.ms-powerpoint", preview: false },
  pptx: {
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    preview: false,
  },
  odt: { mime: "application/vnd.oasis.opendocument.text", preview: false },
  ods: { mime: "application/vnd.oasis.opendocument.spreadsheet", preview: false },
  odp: { mime: "application/vnd.oasis.opendocument.presentation", preview: false },
  zip: { mime: "application/zip", preview: false },
};

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
    .replace(/^\.+/, "")
    .slice(0, MAX_FILENAME_LENGTH)
    .trim();

  return cleaned || "shared-file";
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
  const configured = Number(process.env.MAX_FILE_BYTES ?? 52_428_800);
  if (!Number.isSafeInteger(configured) || configured < 1 || configured > 52_428_800) {
    return 52_428_800;
  }
  return configured;
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
