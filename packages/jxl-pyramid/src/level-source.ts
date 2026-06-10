import { isJxtcContainer, parseJxtcHeader } from "./tiling.js";
import type { PyramidLevel } from "./manifest.js";
import { formatFromBits, bppOfFormat, type PixelFormat, PyramidError } from "./decode-core.js";

/** Uniform handle for whole-frame JXL or tiled JXTC top levels.
 * bytesId is attached lazily by the pool (Grok 2) for the load/decode protocol to avoid N-clones.
 */
export type LevelSource =
  | { kind: "whole"; bytes: Uint8Array; width: number; height: number; bitsPerSample: 8 | 16; format: PixelFormat; bpp: 4 | 8; bytesId?: number }
  | { kind: "tiled"; bytes: Uint8Array; width: number; height: number; tileSize: number; bitsPerSample: 8 | 16; format: PixelFormat; bpp: 4 | 8; bytesId?: number };

export function createLevelSource(
  entry: Pick<PyramidLevel, "w" | "h" | "tiled"> & { bitsPerSample?: 8 | 16 },
  bytes: Uint8Array,
): LevelSource {
  if (entry.tiled) {
    if (!isJxtcContainer(bytes)) {
      throw new PyramidError('JXTC_PARSE', 'manifest level is tiled but bytes are not a JXTC container');
    }
    const header = parseJxtcHeader(bytes);
    const fmt = formatFromBits(header.bitsPerSample);
    const bp = bppOfFormat(fmt);
    return {
      kind: "tiled",
      bytes,
      width: header.imageW,
      height: header.imageH,
      tileSize: header.tileSize,
      bitsPerSample: header.bitsPerSample,
      format: fmt,
      bpp: bp,
    };
  }
  const bits = entry.bitsPerSample ?? 8;
  // L18-1: whole-branch validation (symmetric to parseJxtcHeader for tiled; untrusted manifest entry).
  if (bits !== 8 && bits !== 16) {
    throw new PyramidError('BAD_MANIFEST', `bitsPerSample must be 8 or 16 (got ${bits})`);
  }
  if (!Number.isInteger(entry.w) || entry.w <= 0 || !Number.isInteger(entry.h) || entry.h <= 0) {
    throw new PyramidError('BAD_MANIFEST', `dimensions must be positive integers (got ${entry.w}x${entry.h})`);
  }
  const bpp = bits === 16 ? 8 : 4;
  const total = entry.w * entry.h * bpp;
  if (!Number.isFinite(total) || total > (1 << 30) || entry.w > (1 << 24) || entry.h > (1 << 24)) {
    throw new PyramidError('OOM', 'whole level dimensions exceed 1GiB decode cap');
  }
  const fmt = formatFromBits(bits);
  const bp = bppOfFormat(fmt);
  // whole branch now carries bitsPerSample (Grok1 fix for contracts-003)
  return {
    kind: "whole",
    bytes,
    width: entry.w,
    height: entry.h,
    bitsPerSample: bits,
    format: fmt,
    bpp: bp,
  };
}

/**
 * Ensure the LevelSource is "prepared" for worker protocol use (Grok2).
 * Attaches bytesId lazily (the actual numeric value is assigned by the PyramidWorkerPool
 * instance using its own counter so ids are scoped to the pool, not global module).
 * Safe to call multiple times; idempotent on the source object identity.
 */
export function prepareLevelSource(source: LevelSource): LevelSource {
  if ('bytesId' in source) return source;
  // Marker; the pool will overwrite with a real id the first time this source is used for a decode.
  (source as any).bytesId = undefined;
  return source;
}
