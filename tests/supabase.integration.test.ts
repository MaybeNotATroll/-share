import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import test from "node:test";

const baseUrl = process.env.BASE_URL?.replace(/\/+$/, "");
const enabled = process.env.RUN_SUPABASE_INTEGRATION === "1" && Boolean(baseUrl);

test("configured app opens numbered private spaces, generates unused codes, and never deletes files", { skip: !enabled }, async () => {
  const root = baseUrl!;

  const arbitraryCode = `9${Array.from({ length: 60 }, () => randomInt(0, 10)).join("")}`;
  const opened = await fetch(`${root}/api/spaces/${arbitraryCode}`, { cache: "no-store" });
  assert.equal(opened.status, 200);
  const emptyList = await fetch(`${root}/api/spaces/${arbitraryCode}/files?limit=24`, { cache: "no-store" });
  assert.equal(emptyList.status, 200);
  assert.deepEqual((await emptyList.json()).files, []);

  const generated = await fetch(`${root}/api/spaces/generate`, { method: "POST", cache: "no-store" });
  assert.equal(generated.status, 200);
  const { code } = await generated.json();
  assert.ok(typeof code === "string" && /^[0-9]{100}$/.test(code));

  const prepared = await fetch(`${root}/api/spaces/${code}/files`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ files: [{ name: "integration.txt", size: 5, type: "text/plain" }] }),
    cache: "no-store",
  });
  assert.equal(prepared.status, 201);
  const reservation = (await prepared.json()).uploads[0];
  const uploaded = await fetch(reservation.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "text/plain", "If-None-Match": "*" },
    body: new Blob(["hello"], { type: "text/plain" }),
  });
  assert.ok(uploaded.ok);
  const replay = await fetch(reservation.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "text/plain", "If-None-Match": "*" },
    body: new Blob(["other"], { type: "text/plain" }),
  });
  assert.equal(replay.status, 412);

  const completed = await fetch(`${root}/api/spaces/${code}/files/${reservation.id}/complete`, {
    method: "POST",
    cache: "no-store",
  });
  assert.equal(completed.status, 200);

  const listed = await fetch(`${root}/api/spaces/${code}/files?limit=24`, { cache: "no-store" });
  assert.equal(listed.status, 200);
  const file = (await listed.json()).files[0];
  assert.equal(file.name, "integration.txt");

  const otherCode = `${code.slice(0, 99)}${(Number(code[99]) + 1) % 10}`;
  const otherList = await fetch(`${root}/api/spaces/${otherCode}/files?limit=24`, { cache: "no-store" });
  assert.deepEqual((await otherList.json()).files, []);
  const wrongSpace = await fetch(`${root}/api/spaces/${otherCode}/files/${file.id}?mode=download`, {
    cache: "no-store",
  });
  assert.equal(wrongSpace.status, 404);

  const removal = await fetch(`${root}/api/manage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, action: "delete-file", fileId: file.id }),
    cache: "no-store",
  });
  assert.ok(removal.status === 404 || removal.status === 405);

  const downloadInfo = await fetch(`${root}/api/spaces/${code}/files/${file.id}?mode=download`, {
    cache: "no-store",
  });
  assert.equal(downloadInfo.status, 200);
  const signedDownload = await downloadInfo.json();
  const downloaded = await fetch(signedDownload.url, { cache: "no-store" });
  assert.equal(await downloaded.text(), "hello");
});
