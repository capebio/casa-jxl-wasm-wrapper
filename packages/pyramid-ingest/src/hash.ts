import { createHash } from "node:crypto";
import { resolve } from "node:path";

export function contentHash16(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

export function imageIdForPath(masterPath: string): string {
  return createHash("sha256").update(resolve(masterPath)).digest("hex").slice(0, 16);
}