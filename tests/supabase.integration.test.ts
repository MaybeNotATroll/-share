import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import test from "node:test";

const baseUrl = process.env.BASE_URL?.replace(/\/+$/, "");
const enabled = process.env.RUN_SUPABASE_INTEGRATION === "1" && Boolean(baseUrl);

test("configured app reserves spaces and authorizes private file flows", { skip: !enabled }, async () => {
  const root = baseUrl!;
  let code = "";
  let managementCredential = "";

  try {
    const publicCode = `8${Array.from({ length: 18 }, () => randomInt(0, 10)).join("")}`;
    const publicOpens = await Promise.all(
      Array.from({ length: 5 }, () => fetch(`${root}/api/spaces/${publicCode}`, { cache: "no-store" })),
    );
    assert.ok(publicOpens.every((response) => response.status === 200));

    const idempotencyKey = randomUUID();
    const generationResponses = await Promise.all(
      Array.from({ length: 2 }, () =>
        fetch(`${root}/api/spaces/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idempotencyKey }),
          cache: "no-store",
        }),
      ),
    );
    assert.equal(generationResponses.filter((response) => response.status === 201).length, 1);
    assert.equal(generationResponses.filter((response) => response.status === 409).length, 1);
    const generated = await generationResponses.find((response) => response.status === 201)!.json();
    code = generated.code;
    managementCredential = generated.managementCredential;
    assert.ok(typeof code === "string" && /^[0-9]{100}$/.test(code));
    assert.ok(typeof managementCredential === "string" && managementCredential.length >= 32);

    const opened = await fetch(`${root}/api/spaces/${code}`, { cache: "no-store" });
    assert.equal(opened.status, 200);

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
      headers: { "Content-Type": "text/plain", "x-upsert": "false" },
      body: new Blob(["hello"], { type: "text/plain" }),
    });
    assert.ok(uploaded.ok);

    const completed = await fetch(`${root}/api/spaces/${code}/files/${reservation.id}/complete`, {
      method: "POST",
      cache: "no-store",
    });
    assert.equal(completed.status, 200);

    const listed = await fetch(`${root}/api/spaces/${code}/files?limit=24`, { cache: "no-store" });
    assert.equal(listed.status, 200);
    const file = (await listed.json()).files[0];
    assert.equal(file.name, "integration.txt");

    const denied = await fetch(`${root}/api/manage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        credential: "x".repeat(43),
        action: "delete-file",
        fileId: file.id,
      }),
      cache: "no-store",
    });
    assert.equal(denied.status, 403);

    const downloadInfo = await fetch(`${root}/api/spaces/${code}/files/${file.id}?mode=download`, {
      cache: "no-store",
    });
    assert.equal(downloadInfo.status, 200);
    const signedDownload = await downloadInfo.json();
    const downloaded = await fetch(signedDownload.url, { cache: "no-store" });
    assert.equal(await downloaded.text(), "hello");

    const removed = await fetch(`${root}/api/manage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, credential: managementCredential, action: "delete-file", fileId: file.id }),
      cache: "no-store",
    });
    assert.equal(removed.status, 200);

    const deleted = await fetch(`${root}/api/manage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, credential: managementCredential, action: "delete-space" }),
      cache: "no-store",
    });
    assert.equal(deleted.status, 200);
    code = "";
  } finally {
    if (code && managementCredential) {
      await fetch(`${root}/api/manage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, credential: managementCredential, action: "delete-space" }),
        cache: "no-store",
      }).catch(() => undefined);
    }
  }
});
