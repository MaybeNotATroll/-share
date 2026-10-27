import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";
import type { UploadQuota } from "../src/lib/upload-quota.ts";
import { maxFileBytes } from "../src/lib/files.ts";

const databaseUrl = process.env.QUOTA_TEST_DATABASE_URL;
const exec = promisify(execFile);

// Use only a disposable, migrated PostgreSQL database. These tests exercise the
// actual RPC and trigger in independent connections, not an in-memory model.
async function sql(statement: string): Promise<string> {
  const { stdout } = await exec("psql", [
    databaseUrl!, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", statement,
  ]);
  return stdout.trim();
}

type Reservation = { id?: string; error?: string; quota?: UploadQuota };

test("persistent daily upload quota in PostgreSQL", { skip: !databaseUrl }, async (t) => {
  const spaces = [randomUUID(), randomUUID()];
  const hashes: string[] = [];
  const freshIp = () => {
    const hash = createHash("sha256").update(randomUUID()).digest("hex");
    hashes.push(hash);
    return hash;
  };
  const today = "(clock_timestamp() at time zone 'UTC')::date";
  await sql(`insert into public.spaces (id, code, visibility) values
    ${spaces.map((id) => `('${id}', '${BigInt(`0x${id.replaceAll("-", "")}`)}', 'private')`).join(",")}`);
  t.after(async () => {
    await sql(`delete from public.spaces where id in (${spaces.map((id) => `'${id}'`).join(",")});
      delete from public.daily_upload_usage where ip_hash in (${hashes.map((hash) => `'${hash}'`).join(",")});`);
  });
  const reserve = async (hash: string, size: number, space = spaces[0]): Promise<Reservation> =>
    JSON.parse(await sql(`select public.reserve_r2_upload(
      '${space}', 'quota.txt', '${space}/${randomUUID()}', 'text/plain',
      ${size}, ${maxFileBytes()}, 1073741824, 1000, '${hash}')`));
  const finish = (id: string) => sql(`update public.files set status = 'ready'
    where id = '${id}' and status = 'pending' returning id`);
  const usage = async (hash: string) => Number(await sql(`select coalesce((
    select uploaded_bytes from public.daily_upload_usage where ip_hash = '${hash}' and day = ${today}), 0)`));
  const seed = (hash: string, bytes: number) => sql(`insert into public.daily_upload_usage
    (ip_hash, day, uploaded_bytes) values ('${hash}', ${today}, ${bytes})`);

  await t.test("one 500 MB attachment consumes only its IP's daily allowance across spaces", async () => {
    const space = randomUUID();
    spaces.push(space);
    await sql(`insert into public.spaces (id, code, visibility)
      values ('${space}', '${BigInt(`0x${space.replaceAll("-", "")}`)}', 'private')`);
    const ip = freshIp();
    const file = await reserve(ip, 500_000_000, space);
    assert.ok(file.id, "the former 50 MiB limit must not reject a 500 MB file");
    assert.equal(await usage(ip), 0);
    assert.equal((await reserve(ip, 1, spaces[1])).error, "uploads_in_progress");
    await finish(file.id);
    assert.equal(await usage(ip), 500_000_000);
    assert.equal((await reserve(ip, 1, spaces[1])).error, "daily_upload_limit");
    assert.ok((await reserve(freshIp(), 500_000_000, space)).id, "another IP has its own full allowance");
    await assert.rejects(reserve(freshIp(), 500_000_001, space), /invalid_upload/);
  });

  await t.test("below and exactly at limit; above-limit rejection preserves ready files", async () => {
    const ip = freshIp();
    for (let i = 0; i < 10; i++) {
      const reservation = await reserve(ip, 50_000_000, spaces[i % 2]);
      assert.ok(reservation.id);
      assert.equal(await usage(ip), i * 50_000_000, "reservations are not successful usage");
      await finish(reservation.id);
    }
    assert.equal(await usage(ip), 500_000_000);
    const rejected = await reserve(ip, 1);
    assert.equal(rejected.error, "daily_upload_limit");
    assert.equal(rejected.quota?.overLimitBytes, 1);
    assert.equal(rejected.quota?.remainingBytes, 0);
    assert.equal(Number(await sql(`select count(*) from public.files
      where upload_ip_hash = '${ip}' and status = 'ready'`)), 10);
    assert.equal(await usage(ip), 500_000_000);
  });

  await t.test("exact server totals across spaces and independent IPs", async () => {
    const ip = freshIp();
    await seed(ip, 480_000_000);
    const rejected = await reserve(ip, 30_000_001, spaces[1]);
    assert.equal(rejected.error, "daily_upload_limit");
    assert.deepEqual({
      used: rejected.quota?.uploadedBytes, file: rejected.quota?.fileBytes,
      total: rejected.quota?.wouldTotalBytes, over: rejected.quota?.overLimitBytes,
      left: rejected.quota?.remainingBytes,
    }, { used: 480_000_000, file: 30_000_001, total: 510_000_001, over: 10_000_001, left: 20_000_000 });
    const accepted = await reserve(ip, 20_000_000);
    assert.ok(accepted.id, "rejecting a large file does not prevent a smaller one");
    assert.ok((await reserve(freshIp(), 50_000_000, spaces[1])).id);
  });

  await t.test("failed and cancelled uploads release reservations without consuming usage", async () => {
    const ip = freshIp();
    await seed(ip, 450_000_000);
    const pending = await reserve(ip, 50_000_000);
    assert.ok(pending.id);
    const busy = await reserve(ip, 1, spaces[1]);
    assert.equal(busy.error, "uploads_in_progress");
    assert.equal(busy.quota?.uploadedBytes, 450_000_000);
    assert.equal(busy.quota?.reservedBytes, 50_000_000);
    assert.equal(busy.quota?.overLimitBytes, 0, "pending data must not be reported as successful");
    await sql(`delete from public.files where id = '${pending.id}' and status = 'pending'`);
    const retry = await reserve(ip, 50_000_000);
    assert.ok(retry.id);
    assert.equal(await usage(ip), 450_000_000);
    await sql(`delete from public.files where id = '${retry.id}'`);
    assert.ok((await reserve(ip, 50_000_000, spaces[1])).id);
  });

  await t.test("interrupted uploads expire lazily even without cron; expired completion cannot publish", async () => {
    const ip = freshIp();
    await seed(ip, 450_000_000);
    const abandoned = await reserve(ip, 50_000_000);
    await sql(`update public.files set upload_reservation_expires_at = clock_timestamp() - interval '1 second'
      where id = '${abandoned.id}'`);
    await assert.rejects(finish(abandoned.id!), /upload_reservation_expired/);
    assert.equal(await usage(ip), 450_000_000);
    const retry = await reserve(ip, 50_000_000, spaces[1]);
    assert.ok(retry.id, "abandoned reservation no longer holds daily capacity");
    await finish(retry.id);
    assert.equal(await usage(ip), 500_000_000);
  });

  await t.test("a failed completion transaction rolls back publication and successful usage together", async () => {
    const ip = freshIp();
    const file = await reserve(ip, 321);
    await assert.rejects(sql(`begin;
      update public.files set status = 'ready' where id = '${file.id}';
      select 1 / 0;
      commit;`), /division by zero/);
    assert.equal(await usage(ip), 0);
    assert.equal(await sql(`select status from public.files where id = '${file.id}'`), "pending");
    await finish(file.id!);
    assert.equal(await usage(ip), 321);
  });

  await t.test("simultaneous reservations across spaces cannot exceed allowance", async () => {
    const ip = freshIp();
    await seed(ip, 450_000_000);
    const attempts = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      reserve(ip, 10_000_000, spaces[i % 2])));
    const accepted = attempts.filter((result) => result.id);
    assert.equal(accepted.length, 5);
    assert.ok(attempts.filter((result) => !result.id).every((result) => result.error === "uploads_in_progress"));
    await Promise.all(accepted.flatMap((result) => [finish(result.id!), finish(result.id!)]));
    assert.equal(await usage(ip), 500_000_000, "completion retries count exactly once");
    assert.equal((await reserve(ip, 1)).error, "daily_upload_limit");
  });

  await t.test("completion racing with reservations cannot overbook quota", async () => {
    const ip = freshIp();
    await seed(ip, 450_000_000);
    const first = await reserve(ip, 25_000_000);
    const [, ...attempts] = await Promise.all([
      finish(first.id!), ...Array.from({ length: 8 }, (_, i) => reserve(ip, 25_000_000, spaces[i % 2])),
    ]);
    const accepted = (attempts as Reservation[]).filter((result) => result.id);
    assert.equal(accepted.length, 1);
    await finish(accepted[0].id!);
    assert.equal(await usage(ip), 500_000_000);
  });

  await t.test("UTC calendar reset, including pending uploads started on the previous day", async () => {
    const ip = freshIp();
    await sql(`insert into public.daily_upload_usage (ip_hash, day, uploaded_bytes)
      values ('${ip}', ${today} - 1, 500000000)`);
    const pending = await reserve(ip, 25_000_000);
    assert.equal(pending.error, undefined);
    await sql(`update public.files set created_at = clock_timestamp() - interval '1 day'
      where id = '${pending.id}'`);
    await finish(pending.id!);
    assert.equal(await usage(ip), 25_000_000, "successful completion belongs to its UTC completion day");
    const next = await reserve(ip, 1);
    const expectedReset = await sql(`select to_char((${today} + 1)::timestamp, 'YYYY-MM-DD"T"HH24:MI:SS') || '+00:00'`);
    // Force a rejection to obtain the database's authoritative reset time.
    await sql(`update public.daily_upload_usage set uploaded_bytes = 500000000
      where ip_hash = '${ip}' and day = ${today}`);
    const rejected = await reserve(ip, 1);
    assert.equal(Date.parse(rejected.quota!.resetAt), Date.parse(expectedReset));
    assert.ok(next.id);
    const zoned = JSON.parse(await sql(`set time zone 'Pacific/Honolulu';
      select public.reserve_r2_upload('${spaces[0]}', 'quota.txt',
        '${spaces[0]}/${randomUUID()}', 'text/plain', 1, ${maxFileBytes()}, 1073741824, 1000, '${ip}')`));
    assert.equal(Date.parse(zoned.quota.resetAt), Date.parse(expectedReset), "session timezone cannot shift UTC reset");
    const boundaries = await sql(`select
      ('2026-10-27T23:59:59.999Z'::timestamptz at time zone 'UTC')::date,
      ('2026-10-28T00:00:00Z'::timestamptz at time zone 'UTC')::date`);
    assert.equal(boundaries, "2026-10-27|2026-10-28");
  });

  await t.test("deleting successful uploads never refunds today's successful usage", async () => {
    const ip = freshIp();
    const file = await reserve(ip, 123);
    await finish(file.id!);
    await sql(`delete from public.files where id = '${file.id}'`);
    assert.equal(await usage(ip), 123);
    assert.equal(Number(await sql(`select count(*) from public.storage_cleanup_queue
      where storage_key like '${spaces[0]}/%' and storage_provider = 'r2'`)) > 0, true);
  });

  await t.test("pruning historical ledger days cannot reset today's usage", async () => {
    const ip = freshIp();
    await seed(ip, 500_000_000);
    await sql(`insert into public.daily_upload_usage (ip_hash, day, uploaded_bytes)
      values ('${ip}', ${today} - 3, 500000000);
      delete from public.daily_upload_usage where ip_hash = '${ip}' and day < ${today} - 2;`);
    assert.equal(await usage(ip), 500_000_000);
    assert.equal((await reserve(ip, 1)).error, "daily_upload_limit");
    assert.equal(Number(await sql(`select count(*) from public.daily_upload_usage where ip_hash = '${ip}'`)), 1);
  });

  await t.test("public database roles cannot read usage or reserve uploads", async () => {
    for (const role of ["anon", "authenticated"]) {
      await assert.rejects(sql(`set role ${role}; select * from public.daily_upload_usage`), /permission denied/);
      await assert.rejects(sql(`set role ${role}; select public.reserve_r2_upload(
        '${spaces[0]}', 'quota.txt', '${spaces[0]}/${randomUUID()}', 'text/plain',
        1, ${maxFileBytes()}, 1073741824, 1000, '${freshIp()}')`), /permission denied/);
    }
    assert.equal(await sql(`select to_regprocedure(
      'public.reserve_r2_upload(uuid,text,text,text,bigint,bigint,bigint,integer)') is null`), "t");
  });

  await t.test("reapplying the recovery migration preserves files, usage, and exactly-once accounting", async () => {
    const ip = freshIp();
    const completed = await reserve(ip, 123);
    await finish(completed.id!);
    const pending = await reserve(ip, 456);
    const snapshot = await sql(`select row_to_json(f) from public.files f
      where id in ('${completed.id}', '${pending.id}') order by id`);
    const migration = await readFile(new URL(
      "../supabase/migrations/20261027010000_daily_upload_quota.sql", import.meta.url,
    ), "utf8");
    await sql(migration);
    await sql(migration);
    assert.equal(await sql(`select row_to_json(f) from public.files f
      where id in ('${completed.id}', '${pending.id}') order by id`), snapshot);
    assert.equal(await usage(ip), 123);
    assert.equal(await sql(`select count(*) from pg_trigger
      where tgrelid = 'public.files'::regclass and tgname = 'files_account_completed_upload'`), "1");
    assert.equal(await sql(`select count(*) from pg_proc
      where pronamespace = 'public'::regnamespace and proname = 'reserve_r2_upload'`), "1");
    await Promise.all([finish(pending.id!), finish(pending.id!)]);
    await sql(`update public.files set status = 'ready' where id = '${completed.id}'`);
    assert.equal(await usage(ip), 579);
  });
});
