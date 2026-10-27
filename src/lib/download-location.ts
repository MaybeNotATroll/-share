import "server-only";
import type { StorageProvider } from "./storage.ts";

type DownloadFile = {
  owner_token_hash: string | null;
  storage_provider: StorageProvider;
  storage_key: string;
  original_name: string;
};

export async function downloadLocation(
  file: DownloadFile,
  code: string,
  id: string,
  preview: boolean,
  seconds: number,
  requestUrl: string,
  sign: (provider: StorageProvider, key: string, name: string, download: boolean, seconds: number) => Promise<string>,
) {
  if (file.owner_token_hash) {
    return new URL(
      `/api/spaces/${encodeURIComponent(code)}/files/${encodeURIComponent(id)}/content?mode=${preview ? "preview" : "download"}`,
      requestUrl,
    ).href;
  }
  return sign(file.storage_provider, file.storage_key, file.original_name, !preview, seconds);
}
