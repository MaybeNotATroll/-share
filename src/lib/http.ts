import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getSupabase } from "./supabase";

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
  if (!secret) throw new Error("Rate limiting is not configured.");
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
  if (!expected) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function getSpace(code: string, createPublic = false) {
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
  if (!data || data.blocked_at) return null;
  return data;
}

export function isUniqueViolation(error: { code?: string } | null): boolean {
  return error?.code === "23505";
}

export function isExpiredSignedUrlError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("expired");
}
