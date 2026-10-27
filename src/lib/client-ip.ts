import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { ServiceSetupError } from "./service-setup-error.ts";

export function trustedClientIp(request: Request): string {
  const header = process.env.VERCEL === "1"
    ? "x-vercel-forwarded-for"
    : process.env.TRUSTED_PROXY_IP_HEADER;
  if (!header) {
    if (process.env.NODE_ENV === "development") return "127.0.0.1";
    throw new ServiceSetupError("A trusted client IP source is not configured.");
  }
  const ip = request.headers.get(header)?.trim() ?? "";
  if (!isIP(ip) || ip.includes("%")) throw new ServiceSetupError("The trusted client IP is missing or invalid.");
  if (isIP(ip) === 4) return ip;
  // Canonicalize equivalent IPv6 spellings, including mapped IPv4 addresses.
  const normalized = new URL(`http://[${ip}]/`).hostname.slice(1, -1).toLowerCase();
  const mapped = normalized.match(/^::ffff:([a-f0-9]+):([a-f0-9]+)$/);
  if (!mapped) return normalized;
  const value = Number.parseInt(mapped[1], 16) * 65536 + Number.parseInt(mapped[2], 16);
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join(".");
}

export function clientIpKey(request: Request, namespace: string): string {
  const secret = process.env.RATE_LIMIT_SECRET ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (Buffer.byteLength(secret) < 32) throw new ServiceSetupError("Rate limiting is not configured.");
  return createHmac("sha256", secret).update(`${namespace}:${trustedClientIp(request)}`).digest("hex");
}
