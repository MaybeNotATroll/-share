import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cleanupFiles } from "../src/lib/cleanup.ts";

type QueueEntry = { storage_key: string; storage_provider: "r2" | "supabase"; cleanup_after: string };

// Model the query contract; real transaction/trigger behavior needs staging Postgres.
function fixture(count = 0, queued: QueueEntry[] = []) {
  const files = Array.from({ length: count }, (_, id) => ({ id: String(id) }));
  const events: string[] = [];
  let failDatabase = false;
  const database = {
    from(table: string) {
      let action = "select";
      let patch: Partial<QueueEntry> = {};
      let ids: string[] = [];
      let key = "";
      let timestamp = "";
      return {
        select() { return this; },
        delete() { action = "delete"; return this; },
        update(value: Partial<QueueEntry>) { action = "update"; patch = value; return this; },
        lte() { return this; },
        order() { return this; },
        limit() { return this; },
        in(column: string, values: string[]) { if (column === "id") ids = values; return this; },
        eq(column: string, value: string) {
          if (column === "storage_key") key = value;
          if (column === "cleanup_after") timestamp = value;
          return this;
        },
        then(resolve: (result: { data: unknown; error: unknown }) => void) {
          if (failDatabase) return resolve({ data: null, error: { code: "unavailable" } });
          if (action === "select") {
            const data = table === "files" ? files.slice(0, 100)
              : queued.filter((item) => Date.parse(item.cleanup_after) <= Date.now()).slice(0, 100);
            return resolve({ data: structuredClone(data), error: null });
          }
          events.push(`${table}:${action}`);
          if (table === "files" && ids.length) {
            for (let i = files.length - 1; i >= 0; i--) {
              if (!ids.includes(files[i].id)) continue;
              queued.push({ storage_key: files[i].id, storage_provider: "r2", cleanup_after: "2020-01-01T00:00:00Z" });
              files.splice(i, 1);
            }
          } else if (table === "storage_cleanup_queue") {
            const index = queued.findIndex((item) => item.storage_key === key && item.cleanup_after === timestamp);
            if (index >= 0) {
              if (action === "delete") queued.splice(index, 1);
              else Object.assign(queued[index], patch);
            }
          }
          return resolve({ data: null, error: null });
        },
      };
    },
  };
  return {
    database: database as unknown as SupabaseClient,
    files, queued, events,
    failDatabase() { failDatabase = true; },
  };
}

test("cleanup drains more than the old 500-file cap and revokes metadata before object removal", async () => {
  const f = fixture(650);
  const deleted: string[] = [];
  const result = await cleanupFiles(f.database, async (provider, keys) => {
    assert.equal(provider, "r2");
    assert.equal(f.files.length, 0);
    deleted.push(...keys);
  });
  assert.equal(result.removedFiles, 650);
  assert.equal(result.hasMore, false);
  assert.equal(deleted.length, 650);
  assert.equal(f.queued.length, 0);
});

test("failed batches keep durable keys with backoff and do not starve other providers or later batches", async () => {
  const entries = Array.from({ length: 101 }, (_, i): QueueEntry => ({
    storage_key: String(i), storage_provider: i === 1 ? "supabase" : "r2",
    cleanup_after: "2020-01-01T00:00:00Z",
  }));
  const f = fixture(0, entries);
  const attempts: string[] = [];
  const result = await cleanupFiles(f.database, async (_provider, keys) => {
    attempts.push(...keys);
    if (keys.includes("0")) throw new Error("Simulated storage outage");
  });
  assert.equal(result.failedBatches, 1);
  assert.ok(attempts.includes("1"), "legacy provider still gets processed");
  assert.ok(attempts.includes("100"), "later batches still get processed");
  assert.equal(f.queued.length, 99);
  assert.ok(f.queued.every((item) => Date.parse(item.cleanup_after) > Date.now()));
  for (const item of f.queued) item.cleanup_after = "2020-01-01T00:00:00Z";
  await cleanupFiles(f.database, async () => {});
  assert.equal(f.queued.length, 0);
});

test("database failure cannot acknowledge cleanup or invoke object deletion", async () => {
  const f = fixture();
  f.failDatabase();
  await assert.rejects(cleanupFiles(f.database, async () => assert.fail("must not delete")), /unavailable/);
});

test("cleanup yields with explicit backlog when its processing budget expires", async () => {
  const f = fixture(1);
  const result = await cleanupFiles(f.database, async () => {}, Date.now() - 1);
  assert.equal(result.hasMore, true);
  assert.equal(f.files.length, 1);
});

test("concurrently rescheduled tombstones are not acknowledged by stale cleanup", async () => {
  const f = fixture(0, [{
    storage_key: "key", storage_provider: "r2", cleanup_after: "2020-01-01T00:00:00Z",
  }]);
  await cleanupFiles(f.database, async () => {
    f.queued[0].cleanup_after = new Date(Date.now() + 60_000).toISOString();
  });
  assert.equal(f.queued.length, 1);
});
