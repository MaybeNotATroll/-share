import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getVisibility } from "./code";
import { getSupabase } from "./supabase";

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
  const ip =
    request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";
  const secret =
    process.env.RATE_LIMIT_SECRET ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (Buffer.byteLength(secret) < 32) throw new Error("Rate limiting is not configured.");
  const key = createHmac("sha256", secret).update(`${action}:${ip}`).digest("hex");
  const { data, error } = await getSupabase().rpc("check_rate_limit", {
    p_key: key,
    p_limit: limit,
    p_window_seconds: seconds,
  });
  if (error) throw new Error("Rate limiting is temporarily unavailable.");
  return data === true;
}

export function matchesSecret(candidate: string, expected: string | undefined): boolean {
  if (!expected || Buffer.byteLength(expected) < 32) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function getSpace(code: string, createPublic = false, includeBlocked = false) {
  const supabase = getSupabase();
  if (createPublic) {
    const { error } = await supabase
      .from("spaces")
      .upsert({ code, visibility: "public" }, { onConflict: "code", ignoreDuplicates: true });
    if (error) throw new Error("Space is temporarily unavailable.");
  }

  const { data, error } = await supabase
    .from("spaces")
    .select("id,code,visibility,created_at,blocked_at,management_key_hash")
    .eq("code", code)
    .maybeSingle();
  if (error) throw new Error("Space is temporarily unavailable.");
  if (!data || (data.blocked_at && !includeBlocked)) return null;
  return data;
}

export async function resolveSpace(request: Request, code: string) {
  const existing = await getSpace(code);
  if (existing || getVisibility(code) === "private") {
    return { space: existing, rateLimited: false };
  }
  if (!(await enforceRateLimit(request, "public-space-create", 20, 3600))) {
    return { space: null, rateLimited: true };
  }
  return { space: await getSpace(code, true), rateLimited: false };
}

export function isUniqueViolation(error: { code?: string } | null): boolean {
  return error?.code === "23505";
}

export function isExpiredSignedUrlError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("expired");
}
