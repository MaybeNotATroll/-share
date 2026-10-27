import { z } from "zod";

export const FILE_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const expiresInSecondsSchema = z.union([
  z.literal(3600), z.literal(21600), z.literal(43200), z.literal(86400),
]).default(86400);

export function activeFileCutoff(now = Date.now()): string {
  return new Date(now - FILE_LIFETIME_MS).toISOString();
}

export function fileAccessSeconds(createdAt: string, maximum = 60, now = Date.now(), expiresAt?: string): number {
  const remaining = (expiresAt === undefined ? Date.parse(createdAt) + FILE_LIFETIME_MS : Date.parse(expiresAt)) - now;
  if (!Number.isFinite(remaining)) return 0;
  return Math.max(0, Math.min(maximum, Math.floor(remaining / 1000)));
}
