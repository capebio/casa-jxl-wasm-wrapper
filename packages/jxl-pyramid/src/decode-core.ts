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

export function assertFiniteRegion(r: ImageRegion): void {
  // single-expression NaN/Infinity screen: any non-finite member poisons the sum
  if (!Number.isFinite(r.x + r.y + r.w + r.h)) {
    throw new PyramidError('BAD_REGION', `region must have finite x,y,w,h (got ${r.x},${r.y},${r.w},${r.h})`);
  }
}

/** Snap fractional regions to integers: floor the origin, ceil the far edge.
 *  Output always covers the requested rect. Identity (no alloc) for integer input. */
export function snapRegionToIntegers(r: ImageRegion): ImageRegion {
  if (Number.isInteger(r.x) && Number.isInteger(r.y) && Number.isInteger(r.w) && Number.isInteger(r.h)) return r;
  const x = Math.floor(r.x), y = Math.floor(r.y);
  return { x, y, w: Math.ceil(r.x + r.w) - x, h: Math.ceil(r.y + r.h) - y };
}

/** Central clamp (replaces 3 inlined sites: decode-level, pool, tiling). */
export function clampRegion(region: ImageRegion, imageW: number, imageH: number): ImageRegion {
  assertFiniteRegion(region);
  if (!Number.isFinite(imageW) || !Number.isFinite(imageH) || imageW <= 0 || imageH <= 0) {
    throw new RangeError("imageW/H must be positive finite");
  }
  // Early out for common in-bounds case (Grok4).
  // Callers must not mutate the returned region; it may alias the input.
  if (region.x >= 0 && region.y >= 0 && region.x + region.w <= imageW && region.y + region.h <= imageH) {
    return region;
  }
  const rx = clampPositive(region.x, imageW);
  const ry = clampPositive(region.y, imageH);
  const rw = clampPositive(region.w, imageW - rx);
  const rh = clampPositive(region.h, imageH - ry);
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
  const expected = decoded.width * decoded.height * bytesPerPixel;
  if (decoded.pixels.byteLength !== expected) {
    throw new PyramidError('DECODER_OUTPUT_MISMATCH',
      `decoded tile bytes ${decoded.pixels.byteLength} != ${decoded.width}x${decoded.height}x${bytesPerPixel}`);
  }

  // Hoist (Grok4).
  const vw = viewport.w;
  const vx = viewport.x;
  const vy = viewport.y;
  const dx = tile.x - vx;
  const dy = tile.y - vy;

  if (dx < 0 || dy < 0 || dx + decoded.width > viewport.w || dy + decoded.height > viewport.h) {
    throw new PyramidError('STITCH_OOB',
      `dst ${decoded.width}x${decoded.height}@(${dx},${dy}) outside viewport ${viewport.w}x${viewport.h}`);
  }

  const dstStride = vw * bytesPerPixel;
  const srcStride = decoded.width * bytesPerPixel;
  if (decoded.width === vw && dx === 0 && decoded.height + dy <= viewport.h) {
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

/**
 * Stitch a sub-rectangle of a decoded full tile into the viewport buffer.
 * srcRect is in image coordinates and must lie within the decoded tile; the decoded tile's
 * top-left in image coordinates is (srcOriginX, srcOriginY) with row stride decodedW·bpp.
 */
export function stitchCropped(
  outBuffer: Uint8Array,
  viewport: ImageRegion,
  srcRect: ImageRegion,
  decodedPixels: Uint8Array,
  decodedW: number,
  decodedH: number,
  srcOriginX: number,
  srcOriginY: number,
  bytesPerPixel: 4 | 8,
): void {
  const cropX = srcRect.x - srcOriginX, cropY = srcRect.y - srcOriginY;
  if (cropX < 0 || cropY < 0 || cropX + srcRect.w > decodedW || cropY + srcRect.h > decodedH) {
    throw new PyramidError('STITCH_OOB',
      `crop ${srcRect.w}x${srcRect.h}@(${cropX},${cropY}) outside decoded ${decodedW}x${decodedH}`);
  }
  const expected = decodedW * decodedH * bytesPerPixel;
  if (decodedPixels.byteLength !== expected) {
    throw new PyramidError('DECODER_OUTPUT_MISMATCH',
      `decoded tile bytes ${decodedPixels.byteLength} != ${decodedW}x${decodedH}x${bytesPerPixel}`);
  }
  const dx = srcRect.x - viewport.x, dy = srcRect.y - viewport.y;
  if (dx < 0 || dy < 0 || dx + srcRect.w > viewport.w || dy + srcRect.h > viewport.h) {
    throw new PyramidError('STITCH_OOB',
      `dst ${srcRect.w}x${srcRect.h}@(${dx},${dy}) outside viewport ${viewport.w}x${viewport.h}`);
  }
  const srcStride = decodedW * bytesPerPixel;
  const dstStride = viewport.w * bytesPerPixel;
  const rowBytes = srcRect.w * bytesPerPixel;
  let srcOff = (cropY * decodedW + cropX) * bytesPerPixel;
  let dstOff = (dy * viewport.w + dx) * bytesPerPixel;
  if (rowBytes === srcStride && rowBytes === dstStride) {        // full-width, both aligned
    outBuffer.set(decodedPixels.subarray(srcOff, srcOff + rowBytes * srcRect.h), dstOff);
    return;
  }
  for (let row = 0; row < srcRect.h; row++) {
    outBuffer.set(decodedPixels.subarray(srcOff, srcOff + rowBytes), dstOff);
    srcOff += srcStride;
    dstOff += dstStride;
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
  | 'INVALID_BUFFER_SIZE'
  | string;

export class PyramidError extends Error {
  constructor(public code: PyramidErrorCode, message: string, public cause?: unknown) {
    super(message);
    this.name = 'PyramidError';
  }
}

/** F7: stable, immutable tile coordinate for cache keys, telemetry, multi-pass coordination. */
export interface TileId {
  level: number;
  col: number;
  row: number;
}

/** High-perf stable string key for a tile (used for LRU cache keys and logs). */
export function tileKey(tile: TileId): string {
  return `L${tile.level}-C${tile.col}-R${tile.row}`;
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
  // F2 note: outBuffer + onTile together enable Grok 4 stream-stitch (on-arrival writes into caller buffer,
  // no results[] retention, paint as tiles land, reuse buffer across pans for 60fps). See decodeTiledViewport + decodeTilesParallel.
  /**
   * Progressive DC-then-final first-paint (F1, cites L3m-2 L21m-2 L8pm-3).
   * When set, per-tile (or viewport) uses createDecoder({ progressionTarget: 'dc' }) for fast coarse paint,
   * then a second pass to final at the same level/region. Caller's onTile fires twice per tile.
   * Wired to stream-stitch (Grok 4): caller paints DC tiles first, then refines.
   * Undefined (default) = existing one-shot final behavior (no behavior change for happy path).
   */
  progressive?: 'dc-then-final';
}

export type ProgressiveMode = 'dc-then-final' | undefined;
