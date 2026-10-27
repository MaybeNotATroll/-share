import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";

const databaseUrl = process.env.OWNER_TEST_DATABASE_URL;
const exec = promisify(execFile);
async function sql(statement: string) {
  const { stdout } = await exec("psql", [
    databaseUrl!, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", statement,
  ]);
  return stdout.trim();
}

test("owner expiration migration, quota and durable revocation in disposable PostgreSQL",
  { skip: !databaseUrl }, async (t) => {
    const spaces = [randomUUID(), randomUUID()];
    const hash = () => createHash("sha256").update(randomUUID()).digest("hex");
    const owner = hash();
    const ip = hash();
    const foreignIp = hash();
    const keys: string[] = [];
    const migration = await readFile(new URL("../supabase/migrations/20261027020000_owner_expiration.sql", import.meta.url), "utf8");
    await sql(migration);
    await sql(`insert into public.spaces (id,code,visibility) values
      ${spaces.map((id) => `('${id}','${BigInt(`0x${id.replaceAll("-", "")}`)}','private')`).join(",")}`);
    t.after(async () => {
      await sql(`delete from public.spaces where id in (${spaces.map((id) => `'${id}'`).join(",")});
        delete from public.daily_upload_usage where ip_hash in ('${ip}','${foreignIp}');
        delete from public.storage_cleanup_queue where storage_key in (${keys.map((key) => `'${key}'`).concat("''").join(",")});`);
    });
    const reserve = async (seconds = 3600, ipHash = ip, space = spaces[0], ownerHash = owner) => {
      const key = `${space}/${randomUUID()}`;
      keys.push(key);
      return JSON.parse(await sql(`select public.reserve_managed_r2_upload(
        '${space}', 'owner.txt', '${key}', 'text/plain', 100, 500000000, 1073741824,
        1000, '${ipHash}', '${ownerHash}', ${seconds})`)) as { id: string };
    };
    const usage = async (ipHash = ip) =>
      JSON.parse(await sql(`select public.get_daily_upload_usage('${ipHash}')`));
    const complete = async (id: string) =>
      sql(`update public.files set status='ready' where id='${id}'`);

    await t.test("wrapper validates duration/hash before creating any reservation", async () => {
      for (const seconds of [0, -1, 3599, 86401]) await assert.rejects(reserve(seconds), /invalid_managed_upload/);
      await assert.rejects(reserve(3600, ip, spaces[0], "invalid"), /invalid_managed_upload/);
      assert.equal(Number(await sql(`select file_count from public.spaces where id='${spaces[0]}'`)), 0);
      assert.equal((await usage()).reservedBytes, 0);
    });

    await t.test("direct managed inserts cannot exceed the database's 24-hour retention ceiling", async () => {
      const key = `${spaces[0]}/${randomUUID()}`;
      keys.push(key);
      await assert.rejects(sql(`insert into public.files
        (space_id,original_name,storage_key,content_type,size_bytes,storage_provider,owner_token_hash,expires_at)
        values ('${spaces[0]}','direct.txt','${key}','text/plain',1,'r2','${owner}',
          clock_timestamp()+interval '25 hours')`), /files_managed_retention_max/);
      assert.equal(Number(await sql(`select count(*) from public.files where storage_key='${key}'`)), 0);
    });

    const first = await reserve();
    await t.test("only hash is stored; short expiration uses created time; reruns never extend it", async () => {
      const file = JSON.parse(await sql(`select json_build_object('owner',owner_token_hash,
        'seconds',extract(epoch from expires_at-created_at)) from public.files where id='${first.id}'`));
      assert.equal(file.owner, owner);
      assert.equal(file.seconds, 3600);
      await sql(migration);
      assert.equal(Number(await sql(`select extract(epoch from expires_at-created_at)
        from public.files where id='${first.id}'`)), 3600);
      await assert.rejects(sql(`update public.files set expires_at=expires_at+interval '1 second'
        where id='${first.id}'`), /managed_lifetime_immutable/);
      await assert.rejects(sql(`update public.files set owner_token_hash='${hash()}'
        where id='${first.id}'`), /managed_lifetime_immutable/);
    });

    await t.test("per-IP usage spans spaces and reports exact active reservations, never global storage", async () => {
      await reserve(21600, ip, spaces[1]);
      await reserve(43200, foreignIp);
      assert.equal((await usage()).uploadedBytes, 0);
      assert.equal((await usage()).reservedBytes, 200);
      assert.equal((await usage(foreignIp)).reservedBytes, 100);
      await complete(first.id);
      const result = await usage();
      assert.equal(result.uploadedBytes, 100);
      assert.equal(result.reservedBytes, 100);
      assert.equal(result.limitBytes, 500000000);
      assert.match(result.resetAt, /T00:00:00/);
      await sql(`delete from public.files where id='${first.id}'`);
      assert.equal((await usage()).uploadedBytes, 100, "deleting never refunds completed usage");
    });

    await t.test("expired pending publication fails and tombstones retain late PUT grace", async () => {
      const file = await reserve();
      await sql(`update public.files set expires_at=clock_timestamp()-interval '1 second' where id='${file.id}'`);
      await assert.rejects(complete(file.id), /file_expired/);
      assert.equal((await usage()).uploadedBytes, 100);
      await sql(`delete from public.files where id='${file.id}'`);
      assert.equal(await sql(`select cleanup_after > clock_timestamp()+interval '9 minutes'
        from public.storage_cleanup_queue where storage_key='${keys.at(-1)}'`), "t");
    });

    await t.test("old metered RPC remains callable and does not give legacy files an owner", async () => {
      const key = `${spaces[0]}/${randomUUID()}`;
      keys.push(key);
      const old = JSON.parse(await sql(`select public.reserve_r2_upload('${spaces[0]}','legacy.txt',
        '${key}','text/plain',1,500000000,1073741824,1000,'${ip}')`));
      assert.equal(await sql(`select owner_token_hash is null from public.files where id='${old.id}'`), "t");
    });
  });
