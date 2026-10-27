import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { trustedClientIp, clientIpKey } from "../src/lib/client-ip.ts";
import { quotaSize, uploadQuotaMessage, type UploadQuota } from "../src/lib/upload-quota.ts";

function env(t: TestContext, name: string, value?: string) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

test("quota messages preserve exact server byte values, including one-byte excess", () => {
  const quota: UploadQuota = {
    limitBytes: 500_000_000, uploadedBytes: 400_000_000, fileBytes: 200_000_000,
    wouldTotalBytes: 600_000_000, overLimitBytes: 100_000_000, remainingBytes: 100_000_000,
    reservedBytes: 0, resetAt: "2026-10-28T00:00:00+00:00",
  };
  const message = uploadQuotaMessage(quota);
  for (const part of ["500 MB", "uploaded 400 MB", "file is 200 MB", "total to 600 MB", "100 MB over", "100 MB remaining", "midnight UTC"]) {
    assert.ok(message.includes(part), part);
  }
  assert.match(uploadQuotaMessage(quota, "Oct 27, 2026, 5:00 PM PDT"), /5:00 PM PDT/);
  assert.equal(quotaSize(500_000_001), "500.000001 MB (500,000,001 bytes)");
  assert.equal(quotaSize(1), "1 B");
  assert.equal(quotaSize(999_999), "999,999 B");
  assert.equal(quotaSize(1_000_000_001), "1.000000001 GB (1,000,000,001 bytes)");
  assert.match(uploadQuotaMessage({
    ...quota, uploadedBytes: 499_999_999, fileBytes: 2, wouldTotalBytes: 500_000_001,
    overLimitBytes: 1, remainingBytes: 1,
  }), /1 B over your limit.*1 B remaining/);
});

test("Vercel platform IP overrides spoofed browser and proxy headers", (t) => {
  env(t, "VERCEL", "1");
  env(t, "TRUSTED_PROXY_IP_HEADER", "x-real-ip");
  env(t, "RATE_LIMIT_SECRET", "test-only-secret-".repeat(4));
  const request = new Request("https://numa.example", {
    headers: {
      "x-vercel-forwarded-for": "192.0.2.1",
      "x-real-ip": "203.0.113.1",
      "x-forwarded-for": "203.0.113.2, 203.0.113.3",
    },
  });
  assert.equal(trustedClientIp(request), "192.0.2.1");
  assert.match(clientIpKey(request, "daily-upload"), /^[a-f0-9]{64}$/);
  assert.notEqual(clientIpKey(request, "daily-upload"), clientIpKey(request, "upload"));
  const spoofed = new Request(request);
  spoofed.headers.set("x-real-ip", "203.0.113.9");
  assert.equal(clientIpKey(request, "daily-upload"), clientIpKey(spoofed, "daily-upload"));
});

test("missing, invalid, or ambiguous IP fails closed in production", (t) => {
  env(t, "VERCEL", "1");
  env(t, "NODE_ENV", "production");
  for (const ip of ["", "unknown", "192.0.2.1, 192.0.2.2", "192.0.2.1:123", "fe80::1%eth0"]) {
    const request = new Request("https://numa.example", { headers: { "x-vercel-forwarded-for": ip } });
    if (ip.includes("%")) {
      // Scoped IPv6 is not a globally meaningful client identity.
      assert.throws(() => trustedClientIp(request));
    } else {
      assert.throws(() => trustedClientIp(request), /missing or invalid/);
    }
  }
  env(t, "VERCEL");
  env(t, "TRUSTED_PROXY_IP_HEADER");
  assert.throws(() => trustedClientIp(new Request("https://numa.example")), /not configured/);
});

test("explicit trusted proxy source canonicalizes IPv6 and mapped IPv4", (t) => {
  env(t, "VERCEL");
  env(t, "TRUSTED_PROXY_IP_HEADER", "x-real-ip");
  const ip = (value: string) => trustedClientIp(new Request("https://numa.example", {
    headers: { "x-real-ip": value, "x-forwarded-for": "203.0.113.1" },
  }));
  assert.equal(ip("2001:0DB8:0000:0000:0000:0000:0000:0001"), "2001:db8::1");
  assert.equal(ip("::ffff:192.0.2.1"), ip("192.0.2.1"));
  assert.equal(ip("::ffff:c000:201"), ip("192.0.2.1"));
});

test("unproxied development shares loopback quota rather than trusting browser headers", (t) => {
  env(t, "VERCEL");
  env(t, "TRUSTED_PROXY_IP_HEADER");
  env(t, "NODE_ENV", "development");
  assert.equal(trustedClientIp(new Request("http://localhost", {
    headers: { "x-real-ip": "192.0.2.99" },
  })), "127.0.0.1");
});
