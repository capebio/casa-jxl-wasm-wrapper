import { createDecoder, decodeTileContainerRegionRgba8, decodeTileContainerRegionRgba16 } from "@casabio/jxl-wasm";
import type { ImageRegion } from "./tiling.js";
import type { PyramidCache } from "./cache.js";

export interface DecodedLevel {
  pixels: Uint8Array;
  width: number;
  height: number;
}

export type RegionDecoder = (
  bytes: Uint8Array,
  region: ImageRegion,
) => Promise<DecodedLevel>;

// Module-level decoder constants (Grok1)
export const REGION_DECODER_RGBA8: RegionDecoder = async (b, r) => {
  const out = await decodeTileContainerRegionRgba8(b, r);
  return { pixels: out.pixels, width: out.width, height: out.height };
};
export const REGION_DECODER_RGBA16: RegionDecoder = async (b, r) => {
  const out = await decodeTileContainerRegionRgba16(b, r);
  return { pixels: out.pixels, width: out.width, height: out.height };
};

export const pickRegionDecoder = (bits: 8 | 16): RegionDecoder =>
  bits === 16 ? REGION_DECODER_RGBA16 : REGION_DECODER_RGBA8;

export const WHOLE_DECODE_OPTS = Object.freeze({
  progressionTarget: "final" as const,
  emitEveryPass: false,
  preserveIcc: false,
  preserveMetadata: false,
});

export function clampPositive(x: number, max: number): number {
  return x <= 0 ? 0 : (x >= max ? max : x);
}

/** longEdge helper (Grok4 micro-opt): ternary, no Math.max call. */
export function longEdge(w: number, h: number): number {
  return w > h ? w : h;
}

/** Central clamp (replaces 3 inlined sites: decode-level, pool, tiling). */
export function clampRegion(region: ImageRegion, imageW: number, imageH: number): ImageRegion {
  if (!Number.isFinite(imageW) || !Number.isFinite(imageH) || imageW <= 0 || imageH <= 0) {
    throw new RangeError("imageW/H must be positive finite");
  }
  // Early out for common in-bounds case (Grok4).
  const r = region;
  if (r.x >= 0 && r.y >= 0 && r.x + r.w <= imageW && r.y + r.h <= imageH) {
    return { x: r.x, y: r.y, w: r.w, h: r.h };
  }
  const rx = clampPositive(r.x, imageW);
  const ry = clampPositive(r.y, imageH);
  const rw = clampPositive(r.w, imageW - rx);
  const rh = clampPositive(r.h, imageH - ry);
  return { x: rx, y: ry, w: rw, h: rh };
}

/**
 * Write one decoded tile into outBuffer at its offset within viewport.
 * Replaces the parts[] "stitch all" signature (stream-stitch: on-arrival writes).
 * Fast-path stride-aligned kept; fallback row subarray. Indexed loops.
 */
export function stitch(
  outBuffer: Uint8Array,
  viewport: ImageRegion,
  tile: ImageRegion,
  decoded: DecodedLevel,
  bytesPerPixel: 4 | 8,
): void {
  // Hoist (Grok4).
  const vw = viewport.w;
  const vx = viewport.x;
  const vy = viewport.y;
  const dx = tile.x - vx;
  const dy = tile.y - vy;
  const dstStride = vw * bytesPerPixel;
  const srcStride = decoded.width * bytesPerPixel;
  if (decoded.width === vw && dx === 0) {
    // Stride-aligned fast path (full-width tile block at this y).
    outBuffer.set(decoded.pixels, dy * dstStride);
  } else {
    let srcOff = 0;
    let dstOff = (dy * vw + dx) * bytesPerPixel;
    for (let row = 0; row < decoded.height; row++) {
      outBuffer.set(decoded.pixels.subarray(srcOff, srcOff + srcStride), dstOff);
      srcOff += srcStride;
      dstOff += dstStride;
    }
  }
}

// Grok 3: minimal error taxonomy (full in Grok 5 errors.ts). Extended here per spec for lifecycle/cancellation.
export type PyramidErrorCode =
  | 'ABORTED'
  | 'POOL_DESTROYED'
  | 'FACTORY_CONFLICT'
  | 'TIMEOUT'
  | 'INVALID_REPLY'
  | 'EMPTY_LEVELS'
  | 'BAD_REGION'
  | 'JXTC_PARSE'
  | 'OOM'
  | 'INTERNAL'
  | string;

export class PyramidError extends Error {
  constructor(public code: PyramidErrorCode, message: string, public cause?: unknown) {
    super(message);
    this.name = 'PyramidError';
  }
}

export interface DecodeOptions {
  parallel?: boolean;
  decodeRegion?: RegionDecoder;
  signal?: AbortSignal;
  workerFactory?: () => any; // WorkerLike
  pool?: any; // PyramidWorkerPool for explicit
  /** Opt-in decoded viewport cache (keyed by level+region+format; no auto persistence). */
  cache?: PyramidCache;
  /** Caller-owned recyclable buffer for stitched result (must be >= w*h*bpp). Returned .pixels will be this buffer on use. */
  outBuffer?: Uint8Array;
  /** Called after each tile write (parallel) or once for direct (completedCount = tiles done). */
  onTile?: (region: ImageRegion, completedCount: number) => void;
}
