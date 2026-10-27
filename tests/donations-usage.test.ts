import assert from "node:assert/strict";
import test from "node:test";
import { donationUrl } from "../src/lib/donations.ts";
import { readableBytes, usageProgress } from "../src/lib/usage-display.ts";

test("donations require a configured HTTPS hosted-provider link", () => {
  for (const value of [undefined, "", "invalid", "javascript:alert(1)", "http://buy.stripe.com/test", "https://evil.example/pay", "https://buy.stripe.com.evil.example/pay", "https://buy.stripe.com:444/pay", "https://buy.stripe.com/"]) {
    assert.equal(donationUrl(value), null);
  }
  assert.equal(donationUrl("https://buy.stripe.com/test_link"), "https://buy.stripe.com/test_link");
  const withCredentials = new URL("https://buy.stripe.com/test_link");
  withCredentials.username = "example";
  assert.equal(donationUrl(withCredentials.href), null);
  assert.equal(donationUrl("https://www.paypal.com/donate/?hosted_button_id=example"), "https://www.paypal.com/donate/?hosted_button_id=example");
});

test("upload ring uses successful plus reserved bytes, accurate decimal units and unknown limits", () => {
  const usage = { uploadedBytes: 100_000_000, reservedBytes: 25_000_000, limitBytes: 500_000_000, resetAt: "" };
  assert.equal(usageProgress(usage), 25);
  assert.equal(usageProgress({ ...usage, uploadedBytes: 0, reservedBytes: 0 }), 0);
  assert.equal(usageProgress({ ...usage, uploadedBytes: 600_000_000 }), 100);
  assert.equal(usageProgress({ ...usage, limitBytes: 0 }), null);
  assert.equal(usageProgress({ ...usage, uploadedBytes: -1 }), null);
  assert.equal(usageProgress({ ...usage, reservedBytes: NaN }), null);
  assert.equal(readableBytes(500_000_000), "500.0 MB");
  assert.equal(readableBytes(1_000_000_000), "1.00 GB");
  assert.equal(readableBytes(0), "0 B");
});
