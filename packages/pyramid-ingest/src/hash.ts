import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

export function contentHash16(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

// opp-hash-truncation (documented per WU-4):
// Current truncation is 16 hex chars = 64-bit (first 64 bits of SHA-256).
// Birthday collision risk becomes relevant around ~2^32 objects (~4B files).
// 96-bit (24 hex chars) would safely scale to ~2^48 objects.
// Use --verify-hash for integrity on large/pre-existing corpora; future schema v2 may extend to 24-hex.

// I1/I2 (Phase2): NFC + realpath for cross-platform stable imageId (mac win shortnames, unicode).
// Was sync; now async (plan notes manageable; updated callers).
export async function imageIdForPath(masterPath: string): Promise<string> {
  // realpath resolves symlinks/shortnames; NFC normalizes combining chars.
  const resolved = await realpath(resolve(masterPath)).catch(() => resolve(masterPath));
  const nfc = resolved.normalize("NFC");
  return createHash("sha256").update(nfc).digest("hex").slice(0, 16);
}