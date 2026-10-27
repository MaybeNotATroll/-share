import { randomInt } from "node:crypto";
import { MAX_CODE_LENGTH } from "./code.ts";

export function generatePrivateCode(): string {
  return Array.from({ length: MAX_CODE_LENGTH }, () =>
    randomInt(0, 10).toString(),
  ).join("");
}
