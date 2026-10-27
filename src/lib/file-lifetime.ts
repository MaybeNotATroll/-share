export const FILE_LIFETIME_MS = 24 * 60 * 60 * 1000;

export function activeFileCutoff(now = Date.now()): string {
  return new Date(now - FILE_LIFETIME_MS).toISOString();
}

export function fileAccessSeconds(createdAt: string, maximum = 60, now = Date.now()): number {
  const remaining = Date.parse(createdAt) + FILE_LIFETIME_MS - now;
  if (!Number.isFinite(remaining)) return 0;
  return Math.max(0, Math.min(maximum, Math.floor(remaining / 1000)));
}
