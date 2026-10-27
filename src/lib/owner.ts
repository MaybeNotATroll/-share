import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { StorageProvider } from "./storage.ts";

export function ownerCookieName(production = process.env.NODE_ENV === "production") {
  return production ? "__Host-numa-owner" : "numa-owner";
}

export function readOwnerToken(request: Request): string | null {
  const entries = (request.headers.get("cookie") ?? "").split(";")
    .map((entry) => entry.trim().split("="))
    .filter(([name]) => name === ownerCookieName());
  if (entries.length !== 1 || entries[0].length !== 2) return null;
  const token = entries[0][1];
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token) ||
    Buffer.from(token, "base64url").toString("base64url") !== token) return null;
  return token;
}

export function ownerHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function uploadOwner(request: Request) {
  const existing = readOwnerToken(request);
  const token = existing ?? randomBytes(32).toString("base64url");
  return { token, hash: ownerHash(token), isNew: !existing };
}

export function ownerCookie(token: string, production = process.env.NODE_ENV === "production") {
  return `${ownerCookieName(production)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${production ? "; Secure" : ""}`;
}

export function sameOriginMutation(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin || request.headers.get("sec-fetch-site") === "cross-site") return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin && new URL(origin).origin === origin;
  } catch {
    return false;
  }
}

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "private, no-store, max-age=0" } });
}

const cursorSchema = z.object({
  createdAt: z.string().datetime({ offset: true }),
  id: z.string().uuid(),
});

export async function listOwnerFiles(request: Request, database: SupabaseClient) {
  const token = readOwnerToken(request);
  if (!token) return json({ error: "Owner session required." }, 401);
  const cursor = new URL(request.url).searchParams.get("cursor");
  let position: z.infer<typeof cursorSchema> | undefined;
  if (cursor) {
    try {
      if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
      position = cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
      position.createdAt = new Date(position.createdAt).toISOString();
    } catch {
      return json({ error: "Invalid cursor." }, 400);
    }
  }
  const limit = 48;
  let query = database.from("files")
    .select("id,original_name,size_bytes,created_at,expires_at,spaces!inner(code,blocked_at)")
    .eq("owner_token_hash", ownerHash(token)).eq("status", "ready")
    .gt("expires_at", new Date().toISOString()).is("spaces.blocked_at", null)
    .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1);
  if (position) {
    query = query.or(`created_at.lt.${position.createdAt},and(created_at.eq.${position.createdAt},id.lt.${position.id})`);
  }
  const { data, error } = await query;
  if (error) throw new Error("Owner files unavailable.");
  const rows = data ?? [];
  const files = rows.slice(0, limit).map((file) => {
    const space = file.spaces as unknown as { code: string };
    return {
      id: file.id, code: space.code, name: file.original_name,
      size: Number(file.size_bytes), createdAt: file.created_at, expiresAt: file.expires_at,
    };
  });
  const last = files.at(-1);
  const nextCursor = rows.length > limit && last
    ? Buffer.from(JSON.stringify({ createdAt: last.createdAt, id: last.id })).toString("base64url")
    : null;
  return json({ files, nextCursor });
}

export async function deleteOwnerFile(
  request: Request,
  id: string,
  database: SupabaseClient,
  remove: (provider: StorageProvider, keys: string[]) => Promise<void>,
) {
  const token = readOwnerToken(request);
  if (!token) return json({ error: "Owner session required." }, 401);
  if (!sameOriginMutation(request)) return json({ error: "Same-origin request required." }, 403);
  if (!z.string().uuid().safeParse(id).success) return json({ deleted: true });
  // DELETE RETURNING scopes authorization and revocation to one transaction.
  // Its trigger durably queues the object before any best-effort storage call.
  const { data, error } = await database.from("files").delete()
    .eq("id", id).eq("owner_token_hash", ownerHash(token))
    .select("storage_key,storage_provider");
  if (error) throw new Error("Deletion unavailable.");
  for (const file of data ?? []) {
    try {
      await remove(file.storage_provider as StorageProvider, [file.storage_key]);
    } catch {
      // The durable tombstone remains for cleanup; metadata is already revoked.
    }
  }
  return json({ deleted: true });
}
