import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  deleteOwnerFile, listOwnerFiles, ownerCookie, ownerCookieName, ownerHash,
  readOwnerToken, sameOriginMutation, uploadOwner,
} from "../src/lib/owner.ts";
import { backendFixture, type BackendRow } from "./backend-fixture.ts";

const token = randomBytes(32).toString("base64url");
const foreignToken = randomBytes(32).toString("base64url");
const id = "10000000-0000-4000-8000-000000000001";
const hash = ownerHash(token);

function request(path = "/api/owner", options: { cookie?: string | null; origin?: string | null; method?: string } = {}) {
  const headers = new Headers();
  if (options.cookie !== null) headers.set("Cookie", options.cookie ?? `${ownerCookieName()}=${token}`);
  if (options.origin !== null) headers.set("Origin", options.origin ?? "https://numa.example");
  return new Request(`https://numa.example${path}`, { headers, method: options.method ?? "GET" });
}

function row(overrides: BackendRow = {}): BackendRow {
  return {
    id, owner_token_hash: hash, status: "ready", original_name: "test.txt",
    size_bytes: 123, storage_key: "space/key", storage_provider: "r2",
    created_at: "2026-10-27T00:00:00.000Z", expires_at: "2099-01-01T00:00:00.000Z",
    spaces: { code: "123", blocked_at: null }, ...overrides,
  };
}

test("owner sessions use 32 random bytes, only hash for DB, and reuse existing valid cookies", () => {
  const first = uploadOwner(request("/", { cookie: null }));
  const second = uploadOwner(request("/", { cookie: null }));
  assert.equal(Buffer.from(first.token, "base64url").length, 32);
  assert.notEqual(first.token, second.token);
  assert.match(first.hash, /^[a-f0-9]{64}$/);
  assert.notEqual(first.hash, first.token);
  assert.equal(first.isNew, true);
  assert.deepEqual(uploadOwner(request()), { token, hash, isNew: false });
  assert.match(ownerCookie(token, true), /^__Host-numa-owner=/);
  assert.match(ownerCookie(token, true), /; Path=\/; HttpOnly; SameSite=Strict; Max-Age=31536000; Secure$/);
  assert.doesNotMatch(ownerCookie(token, false), /Secure|Domain=/);
});

test("missing, malformed, duplicate and noncanonical cookies are unauthorized", async () => {
  const f = backendFixture([row()]);
  for (const cookie of [null, "", `${ownerCookieName()}=short`, `${ownerCookieName()}=${token}=extra`,
    `${ownerCookieName()}=${token}; ${ownerCookieName()}=${token}`]) {
    const req = request("/", { cookie });
    assert.equal(readOwnerToken(req), null);
    assert.equal((await listOwnerFiles(req, f.database)).status, 401);
    assert.equal((await deleteOwnerFile(req, id, f.database, async () => assert.fail())).status, 401);
  }
  assert.equal(f.rows.length, 1);
});

test("owner listing is owner-only, ready, unexpired, unblocked and returns no secrets", async () => {
  const f = backendFixture([
    row(), row({ id: "foreign", owner_token_hash: ownerHash(foreignToken) }),
    row({ id: "legacy", owner_token_hash: null }), row({ id: "pending", status: "pending" }),
    row({ id: "expired", expires_at: "2000-01-01T00:00:00.000Z" }),
    row({ id: "blocked", spaces: { code: "123", blocked_at: "2026-01-01" } }),
  ]);
  const response = await listOwnerFiles(request(), f.database);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control")!, /no-store/);
  assert.deepEqual(await response.json(), {
    files: [{ id, code: "123", name: "test.txt", size: 123,
      createdAt: "2026-10-27T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" }],
    nextCursor: null,
  });
});

test("owner cursor pagination handles tied timestamps without duplication and rejects filter injection", async () => {
  const f = backendFixture(Array.from({ length: 60 }, (_, i) =>
    row({ id: `10000000-0000-4000-8000-${String(i).padStart(12, "0")}` })));
  const first = await (await listOwnerFiles(request(), f.database)).json();
  assert.equal(first.files.length, 48);
  assert.equal(typeof first.nextCursor, "string");
  const second = await (await listOwnerFiles(request(`/api/owner?cursor=${first.nextCursor}`), f.database)).json();
  assert.equal(second.files.length, 12);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.files, ...second.files].map((file) => file.id)).size, 60);
  for (const raw of ["garbage", "x".repeat(513),
    Buffer.from(JSON.stringify({ createdAt: "2026-01-01),owner_token_hash.neq.foo", id })).toString("base64url")]) {
    assert.equal((await listOwnerFiles(request(`/api/owner?cursor=${raw}`), f.database)).status, 400);
  }
});

test("owner deletion cannot use code/IP to claim foreign or legacy files and is indistinguishable from missing", async () => {
  for (const owner of [ownerHash(foreignToken), null]) {
    const f = backendFixture([row({ owner_token_hash: owner })]);
    const response = await deleteOwnerFile(request("/api/owner/files/" + id, { method: "DELETE" }), id,
      f.database, async () => assert.fail("foreign storage must never be touched"));
    assert.deepEqual(await response.json(), { deleted: true });
    assert.equal(f.rows.length, 1);
  }
  const f = backendFixture();
  assert.deepEqual(await (await deleteOwnerFile(request(), id, f.database, async () => assert.fail())).json(), { deleted: true });
});

test("owner deletion requires same-origin even with valid session", async () => {
  const f = backendFixture([row()]);
  for (const origin of [null, "https://evil.example", "null", "https://numa.example.evil", "https://numa.example/"]) {
    const req = request("/", { origin, method: "DELETE" });
    assert.equal(sameOriginMutation(req), false);
    assert.equal((await deleteOwnerFile(req, id, f.database, async () => assert.fail())).status, 403);
  }
  assert.equal(f.rows.length, 1);
});

test("delete revokes before storage; failures retain durable tombstone and retries are idempotent", async () => {
  const f = backendFixture([row()]);
  let attempts = 0;
  const remove = async () => {
    attempts++;
    assert.equal(f.rows.length, 0);
    assert.deepEqual(f.events, ["metadata-deleted-and-tombstoned"]);
    throw new Error("Storage outage");
  };
  assert.equal((await deleteOwnerFile(request(), id, f.database, remove)).status, 200);
  assert.equal((await deleteOwnerFile(request(), id, f.database, remove)).status, 200);
  assert.equal(attempts, 1);
});

test("DB failure never touches storage or falsely acknowledges deletion/listing", async () => {
  const f = backendFixture([row()]);
  f.failDatabase();
  await assert.rejects(deleteOwnerFile(request(), id, f.database, async () => assert.fail()), /unavailable/);
  await assert.rejects(listOwnerFiles(request(), f.database), /unavailable/);
  assert.equal(f.rows.length, 1);
});
