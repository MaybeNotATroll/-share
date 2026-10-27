import assert from "node:assert/strict";
import test from "node:test";
import { getVisibility, isValidSpaceCode, MAX_CODE_LENGTH } from "../src/lib/code.ts";
import { spaceCodeSchema } from "../src/lib/validation.ts";
import { generatePrivateCode } from "../src/lib/server-code.ts";
import {
  getFileType,
  sanitizeFilename,
  validTypeHint,
  verifyFileSignature,
} from "../src/lib/files.ts";

test("private number generation returns exactly 100 decimal digits", () => {
  const code = generatePrivateCode();
  assert.equal(code.length, MAX_CODE_LENGTH);
  assert.match(code, /^[0-9]{100}$/);
});

test("codes remain strings and preserve leading zeroes", () => {
  const code = `00${"7".repeat(98)}`;
  assert.equal(spaceCodeSchema.parse(code), code);
  assert.equal(spaceCodeSchema.parse("0001"), "0001");
  assert.equal(isValidSpaceCode("1e99"), false);
  assert.equal(isValidSpaceCode("1".repeat(101)), false);
});

test("visibility is based on the exact code string length", () => {
  assert.equal(getVisibility("1"), "public");
  assert.equal(getVisibility("166449264"), "public");
  assert.equal(getVisibility("1".repeat(20)), "public");
  assert.equal(getVisibility("0".repeat(100)), "private");
});

test("code display grouping does not remove or convert digits", async () => {
  const { formatCode } = await import("../src/lib/code.ts");
  const code = `00${"12345".repeat(19)}123`;
  assert.equal(formatCode(code).replaceAll(" ", ""), code);
});

test("filenames are normalized and cannot retain path separators or control characters", () => {
  const name = sanitizeFilename("../folder\\\u0000report\u202efile.pdf");
  assert.equal(name, "folderreportfile.pdf");
  assert.ok(!name.includes("/") && !name.includes("\\"));
  assert.equal(sanitizeFilename("..."), "shared-file");
});

test("file types are selected from server allowlist, not the client MIME hint", () => {
  assert.equal(getFileType("picture.PNG").mime, "image/png");
  assert.equal(validTypeHint("image/png", "image/png"), true);
  assert.equal(validTypeHint("text/html", "image/png"), false);
  assert.throws(() => getFileType("script.svg"), /not supported/);
});

test("supported previews require recognizable file signatures", () => {
  assert.equal(
    verifyFileSignature("png", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    true,
  );
  assert.equal(verifyFileSignature("pdf", new TextEncoder().encode("%PDF-1.7")), true);
  assert.equal(verifyFileSignature("webm", Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3])), true);
  assert.equal(verifyFileSignature("png", new TextEncoder().encode("<script>")), false);
  assert.equal(verifyFileSignature("svg", new TextEncoder().encode("<svg/>")), false);
});
