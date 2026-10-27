import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getVisibility } from "./code";
import { ServiceSetupError } from "./service-setup-error";
import { getSupabase } from "./supabase";
import { clientIpKey } from "./client-ip";

export async function readJsonBody(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; tooLarge: boolean }> {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > maxBytes) return { ok: false, tooLarge: true };
  const reader = request.body?.getReader();
  if (!reader) return { ok: false, tooLarge: false };
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    length += value.length;
    if (length > maxBytes) {
      await reader.cancel();
      return { ok: false, tooLarge: true };
    }
    chunks.push(value);
  }
  try {
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, tooLarge: false };
  }
}

export async function discardSmallRequestBody(request: Request, maxBytes = 1024): Promise<boolean> {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > maxBytes) return false;
  if (request.body) await request.body.cancel().catch(() => undefined);
  return true;
}

export function jsonError(message: string, status: number) {
  return NextResponse.json(
    { error: message },
    {
      status,
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    },
  );
}

export function jsonNoStore(data: unknown, status = 200) {
  return NextResponse.json(data, {
    status,
    headers: { "Cache-Control": "private, no-store, max-age=0" },
  });
}

export async function enforceRateLimit(
  request: Request,
  action: string,
  limit: number,
  seconds: number,
): Promise<boolean> {
  const key = clientIpKey(request, action);
  const { data, error } = await getSupabase().rpc("check_rate_limit", {
    p_key: key,
    p_limit: limit,
    p_window_seconds: seconds,
  });
  if (error) throw databaseError(error, "Rate limiting is temporarily unavailable.");
  return data === true;
}

export function matchesSecret(candidate: string, expected: string | undefined): boolean {
  if (!expected || Buffer.byteLength(expected) < 32) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

const MISSING_SCHEMA_CODES = new Set(["42P01", "42883", "PGRST202", "PGRST205"]);

export function databaseError(error: { code?: string } | null, message: string): Error {
  if (error?.code && MISSING_SCHEMA_CODES.has(error.code)) {
    return new ServiceSetupError("The database migration has not been applied.");
  }
  return new Error(message);
}

export function serviceError(error: unknown) {
  if (error instanceof ServiceSetupError) {
    return jsonError(
      "The service is not set up yet. The site operator must configure Supabase, R2, and rate limiting, and apply the database migrations.",
      503,
    );
  }
  return jsonError("The service is temporarily unavailable. Please try again.", 503);
}

export async function getSpace(code: string, includeBlocked = false) {
  const { data, error } = await getSupabase()
    .from("spaces")
    .select("id,code,created_at,blocked_at")
    .eq("code", code)
    .maybeSingle();
  if (error) throw databaseError(error, "Space is temporarily unavailable.");
  if (!data || (data.blocked_at && !includeBlocked)) return null;
  return data;
}

export async function getOrCreateSpace(code: string) {
  const { error } = await getSupabase()
    .from("spaces")
    .upsert(
      // The legacy visibility column is retained only to satisfy the existing schema
      // constraint. Every space is private and requires its exact code.
      { code, visibility: getVisibility(code) },
      { onConflict: "code", ignoreDuplicates: true },
    );
  if (error) throw databaseError(error, "Space is temporarily unavailable.");
  return getSpace(code);
}

export function isUniqueViolation(error: { code?: string } | null): boolean {
  return error?.code === "23505";
}

export function isExpiredSignedUrlError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("expired");
}
