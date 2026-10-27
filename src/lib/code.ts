export const MAX_CODE_LENGTH = 100;
export const PUBLIC_CODE_MAX_LENGTH = 20;

export function getVisibility(code: string): "public" | "private" {
  return code.length <= PUBLIC_CODE_MAX_LENGTH ? "public" : "private";
}

export function isValidSpaceCode(code: string): boolean {
  return /^[0-9]{1,100}$/.test(code);
}

export function formatCode(code: string): string {
  return code.match(/.{1,5}/g)?.join(" ") ?? code;
}
