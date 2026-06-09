import { createHash } from "node:crypto";
import { resolve } from "node:path";

export function contentHash16(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

// opp-hash-truncation (documented per WU-4):
// Current truncation is 16 hex chars = 64-bit (first 64 bits of SHA-256).
// Birthday collision risk becomes relevant around ~2^32 objects (~4B files).
// 96-bit (24 hex chars) would safely scale to ~2^48 objects.
// Use --verify-hash for integrity on large/pre-existing corpora; future schema v2 may extend to 24-hex.


export function imageIdForPath(masterPath: string): string {
  return createHash("sha256").update(resolve(masterPath)).digest("hex").slice(0, 16);
}