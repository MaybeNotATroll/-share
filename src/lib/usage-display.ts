export type Usage = {
  uploadedBytes: number;
  reservedBytes: number;
  limitBytes: number;
  resetAt: string;
};

export function readableBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}

export function usageProgress(usage: Usage): number | null {
  if (!Number.isFinite(usage.limitBytes) || usage.limitBytes <= 0 ||
      !Number.isFinite(usage.uploadedBytes) || usage.uploadedBytes < 0 ||
      !Number.isFinite(usage.reservedBytes) || usage.reservedBytes < 0) return null;
  return Math.min(100, 100 * (usage.uploadedBytes + usage.reservedBytes) / usage.limitBytes);
}
