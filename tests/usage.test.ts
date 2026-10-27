import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { dailyUploadUsage } from "../src/lib/usage.ts";

test("usage calls only the consistent daily per-IP RPC and returns exact bytes, not global storage", async () => {
  const database = {
    async rpc(name: string, args: unknown) {
      assert.equal(name, "get_daily_upload_usage");
      assert.deepEqual(args, { p_ip_hash: "a".repeat(64) });
      return { data: {
        uploadedBytes: 123456789, reservedBytes: 45678901, limitBytes: 500000000,
        resetAt: "2026-10-28T00:00:00+00:00", storageBytes: 9999999999,
      }, error: null };
    },
  } as unknown as SupabaseClient;
  assert.deepEqual(await dailyUploadUsage(database, "a".repeat(64)), {
    uploadedBytes: 123456789, reservedBytes: 45678901, limitBytes: 500000000,
    resetAt: "2026-10-28T00:00:00+00:00",
  });
});

test("usage fails closed for DB errors and malformed/unsafe counters", async () => {
  for (const result of [{ error: { code: "unavailable" }, data: null }, { error: null, data: null },
    ...[-1, "1", NaN, 9007199254740992].map((uploadedBytes) => ({ error: null, data: {
      uploadedBytes, reservedBytes: 0, limitBytes: 500000000, resetAt: "2026-10-28T00:00:00Z",
    } }))]) {
    const database = { rpc: async () => result } as unknown as SupabaseClient;
    await assert.rejects(dailyUploadUsage(database, "a".repeat(64)), /unavailable/);
  }
});
