import { isJxtcContainer, parseJxtcHeader } from "./tiling.js";
import type { PyramidLevel } from "./manifest.js";
import { formatFromBits, bppOfFormat, type PixelFormat, PyramidError } from "./decode-core.js";

/** Uniform handle for whole-frame JXL or tiled JXTC top levels.
 * Instances are safe to share across concurrent decodes; treat all fields as frozen after creation.
 */
export type LevelSource =
  | { kind: "whole"; bytes: Uint8Array; width: number; height: number; bitsPerSample: 8 | 16; format: PixelFormat; bpp: 4 | 8; level?: number }
  | { kind: "tiled"; bytes: Uint8Array; width: number; height: number; tileSize: number; bitsPerSample: 8 | 16; format: PixelFormat; bpp: 4 | 8; version: 1 | 2; level?: number; tilesX: number; tilesY: number };

export function createLevelSource(
  entry: Pick<PyramidLevel, "w" | "h" | "tiled"> & { bitsPerSample?: 8 | 16 },
  bytes: Uint8Array,
  levelIndex?: number,
): LevelSource {
  if (entry.tiled) {
    if (!isJxtcContainer(bytes)) {
      throw new PyramidError('JXTC_PARSE', 'manifest level is tiled but bytes are not a JXTC container');
    }
    const header = parseJxtcHeader(bytes);
    if ((entry.w && entry.w !== header.imageW) || (entry.h && entry.h !== header.imageH)) {
      throw new PyramidError('BAD_MANIFEST',
        `manifest says ${entry.w}x${entry.h} but JXTC header says ${header.imageW}x${header.imageH}`);
    }
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
      version: header.version,
      level: levelIndex ?? 0,
      tilesX: header.tilesX,
      tilesY: header.tilesY,
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
    level: levelIndex ?? 0,
  };
}
