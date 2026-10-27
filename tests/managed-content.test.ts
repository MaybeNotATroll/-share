import assert from "node:assert/strict";
import test from "node:test";
import { contentRange, managedContent } from "../src/lib/managed-content.ts";
import { expiresInSecondsSchema, fileAccessSeconds } from "../src/lib/file-lifetime.ts";
import { downloadLocation } from "../src/lib/download-location.ts";
import { backendFixture, type BackendRow } from "./backend-fixture.ts";

const id = "10000000-0000-4000-8000-000000000001";
const row: BackendRow = {
  id, storage_key: "private/key", storage_provider: "r2", owner_token_hash: "a".repeat(64),
  original_name: "video.mp4", content_type: "video/mp4", size_bytes: 5, status: "ready",
  expires_at: "2099-01-01T00:00:00.000Z", spaces: { code: "123", blocked_at: null },
};
const request = (range?: string, mode = "preview") => new Request(`https://numa.example/content?mode=${mode}`,
  { headers: range ? { Range: range } : {} });
const bytes = () => new ReadableStream<Uint8Array>({ start(controller) {
  controller.enqueue(new TextEncoder().encode("hello")); controller.close();
} });

test("managed download locations never invoke a presigner; legacy downloads retain signed access", async () => {
  const file = {
    owner_token_hash: "a".repeat(64), storage_provider: "r2" as const,
    storage_key: "private/key", original_name: "test.txt",
  };
  assert.equal(await downloadLocation(file, "123", id, true, 60, async () => assert.fail("must not sign")),
    `/api/spaces/123/files/${id}/content?mode=preview`);
  assert.equal(await downloadLocation(file, "123", id, false, 60, async () => assert.fail("must not sign")),
    `/api/spaces/123/files/${id}/content?mode=download`);
  assert.equal(await downloadLocation({ ...file, owner_token_hash: null }, "123", id, false, 17,
    async (provider, key, name, attachment, seconds) => {
      assert.deepEqual([provider, key, name, attachment, seconds], ["r2", "private/key", "test.txt", true, 17]);
      return "https://legacy-signed.example";
    }), "https://legacy-signed.example");
});

test("upload expiration accepts exactly supported lifetimes, defaults to 24h and rejects coercion", () => {
  assert.equal(expiresInSecondsSchema.parse(undefined), 86400);
  for (const value of [3600, 21600, 43200, 86400]) assert.equal(expiresInSecondsSchema.parse(value), value);
  for (const value of [null, 0, -1, 3599, 3601, 86401, Infinity, "3600", 1.5]) {
    assert.equal(expiresInSecondsSchema.safeParse(value).success, false);
  }
  const now = Date.parse("2026-10-27T01:00:00.000Z");
  const created = "2026-10-27T00:00:00.000Z";
  assert.equal(fileAccessSeconds(created, 60, now, new Date(now).toISOString()), 0);
  assert.equal(fileAccessSeconds(created, 60, now, new Date(now + 2100).toISOString()), 2);
  assert.equal(fileAccessSeconds(created, 60, now, "invalid"), 0);
  assert.equal(fileAccessSeconds(created, 60, now), 60, "legacy retains 24-hour default");
});

test("range parsing supports video suffix/open/end ranges and rejects multipart/unsafe input", () => {
  assert.equal(contentRange(null, 5), null);
  assert.equal(contentRange("bytes=1-3", 5)?.header, "bytes=1-3");
  assert.equal(contentRange("bytes=2-", 5)?.header, "bytes=2-4");
  assert.equal(contentRange("bytes=-2", 5)?.header, "bytes=3-4");
  assert.equal(contentRange("bytes=0-999", 5)?.header, "bytes=0-4");
  for (const value of ["bytes=5-", "bytes=-0", "bytes=-", "bytes=3-1", "bytes=0-1,3-4",
    "bytes=9007199254740992-", "none", "bytes=1-2\r\nX: bad"]) {
    assert.throws(() => contentRange(value, 5), /range/);
  }
});

test("managed content streams without redirect/public URL, ignores upstream MIME and uses safe headers", async () => {
  const f = backendFixture([{ ...row, original_name: 'bad\r\n"title.mp4' }]);
  const response = await managedContent(request(), "123", id, f.database, async (key, range, signal) => {
    assert.equal(key, "private/key"); assert.equal(range, undefined); assert.ok(signal);
    return { body: bytes(), length: 5 };
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("location"), null);
  assert.equal(response.headers.get("content-type"), "video/mp4");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("cache-control")!, /no-store/);
  assert.doesNotMatch(response.headers.get("content-disposition")!, /[\r\n"]/);
  assert.equal(await response.text(), "hello");
});

test("each content request rechecks revocation, short expiration, readiness, code and blocked space", async () => {
  for (const overrides of [
    { expires_at: "2000-01-01T00:00:00.000Z" }, { status: "pending" }, { owner_token_hash: null },
    { spaces: { code: "999", blocked_at: null } }, { spaces: { code: "123", blocked_at: "now" } },
  ]) {
    const f = backendFixture([{ ...row, ...overrides }]);
    assert.equal((await managedContent(request(), "123", id, f.database, async () => assert.fail())).status, 404);
  }
  const f = backendFixture([row]);
  let calls = 0;
  const read = async () => { calls++; return { body: bytes(), length: 5 }; };
  const first = await managedContent(request(), "123", id, f.database, read);
  assert.equal(first.status, 200);
  f.rows.splice(0);
  assert.equal((await managedContent(request(), "123", id, f.database, read)).status, 404);
  assert.equal(calls, 1, "deleted metadata prevents new object requests");
  assert.equal(await first.text(), "hello", "already-authorized stream cannot be revoked");
});

test("managed content enforces range response and handles storage/DB errors without leaking keys", async () => {
  const f = backendFixture([row]);
  const partial = await managedContent(request("bytes=1-3"), "123", id, f.database, async (_key, range) => {
    assert.equal(range, "bytes=1-3");
    return { body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2, 3])); c.close(); } }),
      length: 3, contentRange: "bytes 1-3/5" };
  });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("content-range"), "bytes 1-3/5");
  assert.equal((await partial.arrayBuffer()).byteLength, 3);
  const invalid = await managedContent(request("bytes=5-"), "123", id, f.database, async () => assert.fail());
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get("content-range"), "bytes */5");
  assert.equal((await managedContent(request("bytes=1-3"), "123", id, f.database,
    async () => ({ body: bytes(), length: 5 }))).status, 503, "upstream cannot ignore Range");
  for (const [name, expected] of [["NoSuchKey", 404], ["InvalidRange", 416], ["AccessDenied", 503]] as const) {
    const response = await managedContent(request(), "123", id, f.database, async () => {
      throw Object.assign(new Error("private/key secret detail"), { name });
    });
    assert.equal(response.status, expected);
    assert.doesNotMatch(await response.text(), /private|secret/);
  }
  f.failDatabase();
  assert.equal((await managedContent(request(), "123", id, f.database, async () => assert.fail())).status, 503);
});

test("HTML MIME and unknown file extensions are never served, nonpreview types use attachment only", async () => {
  for (const overrides of [{ content_type: "text/html" }, { original_name: "evil.html", content_type: "text/html" }]) {
    const f = backendFixture([{ ...row, ...overrides }]);
    assert.equal((await managedContent(request(), "123", id, f.database, async () => assert.fail())).status, 415);
  }
  const f = backendFixture([{ ...row, original_name: "plain.txt", content_type: "text/plain" }]);
  assert.equal((await managedContent(request(), "123", id, f.database, async () => assert.fail())).status, 415);
  const response = await managedContent(request(undefined, "download"), "123", id, f.database,
    async () => ({ body: bytes(), length: 5 }));
  assert.match(response.headers.get("content-disposition")!, /^attachment/);
});

test("PDF previews override global frame denial with a same-origin, script-free sandbox", async () => {
  const f = backendFixture([{ ...row, original_name: "document.pdf", content_type: "application/pdf" }]);
  const response = await managedContent(request(), "123", id, f.database,
    async () => ({ body: bytes(), length: 5 }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.match(response.headers.get("content-disposition")!, /^inline/);
  assert.equal(response.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.match(response.headers.get("content-security-policy")!, /sandbox allow-same-origin;/);
  assert.match(response.headers.get("content-security-policy")!, /frame-ancestors 'self'/);
  assert.doesNotMatch(response.headers.get("content-security-policy")!, /allow-scripts|unsafe-inline|unsafe-eval/);
});
