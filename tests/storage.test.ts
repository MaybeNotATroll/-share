import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { DeleteObjectsCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { activeFileCutoff, fileAccessSeconds, FILE_LIFETIME_MS } from "../src/lib/file-lifetime.ts";
import { createDownloadUrl, createUploadUrl, getR2Client, readUploadedHeader, removeObjects } from "../src/lib/storage.ts";
import { maxFileBytes, maxSpaceBytes, uploadRateLimit, uploadRateWindowSeconds } from "../src/lib/files.ts";

function env(t: TestContext, name: string, value: string) {
  const previous = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

test("24-hour access boundary is exclusive and presigned lifetimes never exceed it", () => {
  const now = Date.parse("2026-10-27T00:00:00Z");
  assert.equal(activeFileCutoff(now), "2026-10-26T00:00:00.000Z");
  assert.equal(fileAccessSeconds("2026-10-26T00:00:00Z", 60, now), 0);
  assert.equal(fileAccessSeconds("2026-10-26T00:00:00.999Z", 60, now), 0);
  assert.equal(fileAccessSeconds("2026-10-26T00:00:02.500Z", 60, now), 2);
  assert.equal(fileAccessSeconds(new Date(now).toISOString(), 60, now), 60);
  assert.equal(fileAccessSeconds(new Date(now - FILE_LIFETIME_MS - 1).toISOString(), 60, now), 0);
  assert.equal(fileAccessSeconds("invalid", 60, now), 0);
});

test("server operational limits use configured values and safe defaults", (t) => {
  env(t, "MAX_SPACE_BYTES", "9999");
  env(t, "UPLOAD_RATE_LIMIT", "3");
  env(t, "UPLOAD_RATE_WINDOW_SECONDS", "120");
  assert.equal(maxSpaceBytes(), 9999);
  assert.equal(uploadRateLimit(), 3);
  assert.equal(uploadRateWindowSeconds(), 120);
  process.env.UPLOAD_RATE_LIMIT = "0";
  process.env.UPLOAD_RATE_WINDOW_SECONDS = "NaN";
  assert.equal(uploadRateLimit(), 12);
  assert.equal(uploadRateWindowSeconds(), 60);
});

test("single attachments can use the full 500 MB daily allowance regardless of legacy configuration", (t) => {
  env(t, "MAX_FILE_BYTES", "52428800");
  assert.equal(maxFileBytes(), 500_000_000);
  process.env.MAX_FILE_BYTES = "1234";
  assert.equal(maxFileBytes(), 500_000_000);
  delete process.env.MAX_FILE_BYTES;
  assert.equal(maxFileBytes(), 500_000_000);
});

function configureR2(t: TestContext) {
  env(t, "R2_ACCOUNT_ID", "0".repeat(32));
  env(t, "R2_ACCESS_KEY_ID", "test-access-key");
  env(t, "R2_SECRET_ACCESS_KEY", "test-only-not-a-real-credential");
}

test("R2 fails closed without valid server configuration", (t) => {
  env(t, "R2_ACCOUNT_ID", "");
  assert.throws(getR2Client, /not configured/);
  process.env.R2_ACCOUNT_ID = "https://untrusted.example";
  assert.throws(getR2Client, /not configured/);
});

test("upload signing binds exact length, type and write-once conditional with five minute TTL", async (t) => {
  configureR2(t);
  const url = new URL(await createUploadUrl("space/random-key", maxFileBytes(), "text/plain"));
  assert.equal(url.host, `${"0".repeat(32)}.r2.cloudflarestorage.com`);
  assert.match(url.pathname, /number-share-files\/space\/random-key$/);
  const signedHeaders = url.searchParams.get("X-Amz-SignedHeaders")?.split(";");
  for (const header of ["content-length", "content-type", "if-none-match"]) {
    assert.ok(signedHeaders?.includes(header), `${header} must be signed`);
  }
  assert.equal(url.searchParams.get("X-Amz-Expires"), "300");
  assert.ok(!url.href.includes(process.env.R2_SECRET_ACCESS_KEY!));
});

test("download signing is private, attachment-safe, and rejects expired or unknown providers", async (t) => {
  configureR2(t);
  const url = new URL(await createDownloadUrl("r2", "space/key", "file's résumé.txt", true, 2));
  assert.equal(url.searchParams.get("X-Amz-Expires"), "2");
  assert.equal(url.searchParams.get("response-cache-control"), "private, no-store, max-age=0");
  assert.match(url.searchParams.get("response-content-disposition")!, /^attachment; filename\*=UTF-8''file%27s/);
  await assert.rejects(createDownloadUrl("r2", "key", "x", false, 0), /expired/);
  await assert.rejects(createDownloadUrl("unexpected" as "r2", "key", "x", false, 5), /Unknown/);
});

test("object header validation uses a bounded authenticated range request", async (t) => {
  configureR2(t);
  t.mock.method(S3Client.prototype, "send", async (command: GetObjectCommand) => {
    assert.ok(command instanceof GetObjectCommand);
    assert.equal(command.input.Range, "bytes=0-511");
    return {
      ContentRange: "bytes 0-4/5", ContentLength: 5, ContentType: "text/plain",
      Body: { transformToByteArray: async () => new TextEncoder().encode("hello") },
    };
  });
  const result = await readUploadedHeader("space/key");
  assert.equal(result.size, 5);
  assert.equal(result.contentType, "text/plain");
  assert.equal(new TextDecoder().decode(result.bytes), "hello");
});

test("object deletion detects per-object errors even when the S3 response succeeds", async (t) => {
  configureR2(t);
  t.mock.method(S3Client.prototype, "send", async (command: DeleteObjectsCommand) => {
    assert.ok(command instanceof DeleteObjectsCommand);
    assert.equal(command.input.Bucket, "number-share-files");
    return { Errors: [{ Key: "space/key", Code: "AccessDenied" }] };
  });
  await assert.rejects(removeObjects("r2", ["space/key"]), /removal failed/);
});
