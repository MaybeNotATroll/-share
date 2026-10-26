import { randomInt } from "node:crypto";
import { z } from "zod";

export const MAX_CODE_LENGTH = 100;
export const PUBLIC_CODE_MAX_LENGTH = 20;

export const spaceCodeSchema = z
  .string()
  .regex(/^[0-9]{1,100}$/, "Enter between 1 and 100 digits.");

export function generatePrivateCode(): string {
  return Array.from({ length: MAX_CODE_LENGTH }, () =>
    randomInt(0, 10).toString(),
  ).join("");
}

export function getVisibility(code: string): "public" | "private" {
  return code.length <= PUBLIC_CODE_MAX_LENGTH ? "public" : "private";
}

export function formatCode(code: string): string {
  return code.match(/.{1,5}/g)?.join(" ") ?? code;
}
