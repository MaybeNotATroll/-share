import assert from "node:assert/strict";
import { randomBytes, randomInt } from "node:crypto";
import test from "node:test";

const root = process.env.BASE_URL?.replace(/\/+$/, "");
const configured = process.env.RUN_SUPABASE_INTEGRATION === "1" && Boolean(root);

test("owner HTTP endpoints require cookies before accessing backend services", { skip: !root }, async () => {
  for (const [path, method] of [["/api/owner", "GET"],
    ["/api/owner/files/10000000-0000-4000-8000-000000000001", "DELETE"]]) {
    const response = await fetch(`${root}${path}`, { method });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.match(response.headers.get("cache-control")!, /no-store/);
  }
});

test("managed uploads enforce expiration, session ownership and immediate content revocation over HTTP",
  { skip: !configured }, async () => {
    const code = `9${Array.from({ length: 60 }, () => randomInt(0, 10)).join("")}`;
    const uploadEndpoint = `${root}/api/spaces/${code}/files`;
    const metadata = { files: [{ name: "managed.txt", size: 5, type: "text/plain" }] };
    for (const expiresInSeconds of [0, 3601, 86401, "3600", null]) {
      const invalid = await fetch(uploadEndpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...metadata, expiresInSeconds }),
      });
      assert.equal(invalid.status, 400);
      assert.equal(invalid.headers.get("set-cookie"), null);
    }
    const prepared = await fetch(uploadEndpoint, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...metadata, expiresInSeconds: 3600 }),
    });
    assert.equal(prepared.status, 201);
    const setCookie = prepared.headers.get("set-cookie");
    assert.ok(setCookie);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    const cookie = setCookie.split(";")[0];
    const cookieName = cookie.split("=")[0];
    const { uploads } = await prepared.json();
    const file = uploads[0];
    const before = await (await fetch(`${root}/api/owner`, { headers: { Cookie: cookie } })).json();
    assert.ok(!before.files.some((item: { id: string }) => item.id === file.id), "pending is not a post");
    const put = await fetch(file.uploadUrl, {
      method: "PUT", headers: { "Content-Type": "text/plain", "If-None-Match": "*" },
      body: new Blob(["hello"], { type: "text/plain" }),
    });
    assert.ok(put.ok);
    assert.equal((await fetch(`${uploadEndpoint}/${file.id}/complete`, {
      method: "POST", headers: { Cookie: cookie },
    })).status, 200);
    const owner = await (await fetch(`${root}/api/owner`, { headers: { Cookie: cookie } })).json();
    const post = owner.files.find((item: { id: string }) => item.id === file.id);
    assert.ok(post);
    assert.equal(Date.parse(post.expiresAt) - Date.parse(post.createdAt), 3600000);
    const locationResponse = await fetch(`${uploadEndpoint}/${file.id}`);
    const { url } = await locationResponse.json();
    const content = new URL(url, root);
    assert.equal(content.origin, new URL(root!).origin);
    assert.doesNotMatch(url, /X-Amz|cloudflarestorage/);
    assert.equal(await (await fetch(content)).text(), "hello");
    const removeUrl = `${root}/api/owner/files/${file.id}`;
    const origin = new URL(root!).origin;
    const foreignCookie = `${cookieName}=${randomBytes(32).toString("base64url")}`;
    assert.equal((await fetch(removeUrl, {
      method: "DELETE", headers: { Cookie: foreignCookie, Origin: origin },
    })).status, 200);
    assert.equal((await fetch(content)).status, 200, "foreign deletion cannot revoke the file");
    assert.equal((await fetch(removeUrl, {
      method: "DELETE", headers: { Cookie: cookie, Origin: "https://foreign.invalid" },
    })).status, 403);
    const usageBefore = await (await fetch(`${root}/api/usage`)).json();
    assert.equal(usageBefore.limitBytes, 500000000);
    assert.ok(usageBefore.uploadedBytes >= 5);
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.deepEqual(await (await fetch(removeUrl, {
        method: "DELETE", headers: { Cookie: cookie, Origin: origin },
      })).json(), { deleted: true });
    }
    assert.equal((await fetch(content)).status, 404, "even an already-issued content URL is revoked");
    const usageAfter = await (await fetch(`${root}/api/usage`)).json();
    assert.ok(usageAfter.uploadedBytes >= usageBefore.uploadedBytes, "deleting cannot refund daily usage");
    const reused = await fetch(uploadEndpoint, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(metadata),
    });
    assert.equal(reused.status, 201);
    assert.equal(reused.headers.get("set-cookie"), null, "existing owner token is reused");
    const pending = (await reused.json()).uploads[0];
    assert.equal((await fetch(`${root}/api/owner/files/${pending.id}`, {
      method: "DELETE", headers: { Cookie: cookie, Origin: origin },
    })).status, 200);
  });
