import { createHash } from "node:crypto";
import { resolve } from "node:path";

/** Content-address a level's JXL bytes: first 16 hex chars (64 bits) of SHA-256. */
export function contentHash16(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

/** Stable per-master id: SHA-256 of the resolved absolute path, first 16 hex chars. */
export function imageIdForPath(masterPath: string): string {
  return createHash("sha256").update(resolve(masterPath)).digest("hex").slice(0, 16);
}
