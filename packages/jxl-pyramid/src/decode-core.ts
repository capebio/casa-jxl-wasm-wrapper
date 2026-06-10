import { createDecoder, decodeTileContainerRegionRgba8, decodeTileContainerRegionRgba16 } from "@casabio/jxl-wasm";
import type { ImageRegion } from "./tiling.js";
import type { PyramidCache } from "./cache.js";

export type PixelFormat = 'rgba8' | 'rgba16';

export interface DecodedLevel {
  pixels: Uint8Array;
  width: number;
  height: number;
  format?: PixelFormat;
  /**
   * When errorPolicy='skip-tile' and tile decodes failed, lists the grid tiles that were zero-filled (L20-1).
   * See DecodeOptions.errorPolicy for the viewport cache contract: do not cache a DecodedLevel with failedTiles
   * under a 'final' viewportCacheKey — later hits would return zero-filled holes as complete final pixels.
   */
  failedTiles?: TileId[];
}

export const formatFromBits = (bits: 8 | 16): PixelFormat => (bits === 16 ? 'rgba16' : 'rgba8');
export const bppOfFormat = (f: PixelFormat): 4 | 8 => (f === 'rgba16' ? 8 : 4);

export type RegionDecoder = (
  bytes: Uint8Array,
  region: ImageRegion,
) => Promise<DecodedLevel>;

// Module-level decoder constants (Grok1)
export const REGION_DECODER_RGBA8: RegionDecoder = async (b, r) => {
  const out = await decodeTileContainerRegionRgba8(b, r);
  return { pixels: out.pixels, width: out.width, height: out.height, format: 'rgba8' };
};
export const REGION_DECODER_RGBA16: RegionDecoder = async (b, r) => {
  const out = await decodeTileContainerRegionRgba16(b, r);
  return { pixels: out.pixels, width: out.width, height: out.height, format: 'rgba16' };
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
  // Bounds + exact byte length checks (as implemented for the crop case in stitchCropped).
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
  if (decoded.width === vw && dx === 0 /* decoded.height + dy <= viewport.h guaranteed by STITCH_OOB guard above */) {
    // Fast path: stride-aligned full-width tile block at this y. The height bound is already enforced by the
    // STITCH_OOB throw immediately prior; omitting the redundant test here removes one branch per aligned tile write.
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

/** L10-R4: reverse-trust validation that decoder delivered the exact region/size/bpp requested.
 * Throws DECODER_OUTPUT_MISMATCH on dim or byteLength mismatch.
 */
export function validateDecodedOutput(decoded: DecodedLevel, expectedRegion: ImageRegion, bpp: 4 | 8): void {
  if (decoded.width !== expectedRegion.w || decoded.height !== expectedRegion.h) {
    throw new PyramidError('DECODER_OUTPUT_MISMATCH',
      `decoded size ${decoded.width}x${decoded.height} != expected ${expectedRegion.w}x${expectedRegion.h}`);
  }
  const expectedBytes = expectedRegion.w * expectedRegion.h * bpp;
  if (decoded.pixels.byteLength !== expectedBytes) {
    throw new PyramidError('DECODER_OUTPUT_MISMATCH',
      `decoded bytes ${decoded.pixels.byteLength} != ${expectedBytes} for region ${expectedRegion.w}x${expectedRegion.h}x${bpp}`);
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
  | 'BUFFER_IN_USE'
  | 'BAD_MANIFEST'
  | 'INVALID_BUFFER_ALIGNMENT'
  | 'DECODER_OUTPUT_MISMATCH'
  | 'DIM_MISMATCH'
  | (string & {});

export class PyramidError extends Error {
  constructor(public code: PyramidErrorCode, message: string, public cause?: unknown) {
    super(message, { cause });
    this.name = 'PyramidError';
  }
}

/**
 * Race a promise against an AbortSignal.
 * - Cleans up listeners on either settlement.
 * - If abort wins, swallows rejection from p to prevent orphaned unhandled rejection.
 * - Pre-aborted signal: swallows p and rejects immediately.
 */
export function raceWithAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) {
    p.catch(() => {});
    return Promise.reject(new PyramidError('ABORTED', 'decode aborted before start', signal.reason));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      p.catch(() => {}); // prevent orphaned rejection from the raced promise
      reject(new PyramidError('ABORTED', 'decode aborted', signal.reason));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (val) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(val);
      },
      (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      },
    );
  });
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

/** F7: canonical TileId for a (clipped) tile rect — col/row from grid origin. */
export function tileIdOf(rect: ImageRegion, tileSize: number, level: number): TileId {
  return { level, col: Math.floor(rect.x / tileSize), row: Math.floor(rect.y / tileSize) };
}

/** Packed numeric tile key for hot maps: level ≤ 8190, col/row < 2^20 — keeps value < 2^53 (exact in IEEE double). */
export function tileKeyPacked(tile: TileId): number {
  // level ≤ 8190, col/row < 2^20 — documented bound tightened from <8192 because
  // 8191 * 2^40 + (2^20-1)*2^20 + (2^20-1) exceeds 2^53-1. Real pyramids use << 32 levels.
  // Dev guard (no prod cost) to catch contract violations early.
  if (process.env.NODE_ENV !== 'production') {
    if (
      !Number.isInteger(tile.level) || tile.level > 8190 || tile.level < 0 ||
      !Number.isInteger(tile.col) || tile.col < 0 || tile.col >= (1 << 20) ||
      !Number.isInteger(tile.row) || tile.row < 0 || tile.row >= (1 << 20)
    ) {
      throw new PyramidError('BAD_REGION', `tileKeyPacked bounds violation: level=${tile.level} col=${tile.col} row=${tile.row} (level≤8190, col/row<2^20)`);
    }
  }
  return tile.level * 0x10000000000 + tile.row * 0x100000 + tile.col;
}

/** L1-3: stable viewport cache key (quality distinguishes dc/final for progressive). */
export function viewportCacheKey(
  levelId: string,
  vp: ImageRegion,
  format: PixelFormat,
  quality: 'dc' | 'final',
): string {
  return `${levelId}:${vp.x},${vp.y},${vp.w},${vp.h}:${format}:q${quality}`;
}

export interface TileProgress {
  id: TileId;
  key: string;
  stage: 'dc' | 'final';
  completed: number;
  total: number;
  /**
   * Optional per-tile cost/identity fields (P3, Lens 12/14/16).
   * decodeMs: wall time for this tile's decode stage (for AR real-time dc-vs-final decisions, latency budgeting).
   * bytesDecoded: compressed bytes consumed for this tile (ML pipeline cost accounting, photogrammetry QC for re-capture).
   * Backward-compatible: third arg to onTile has always been optional; existing two-arg callers unaffected.
   * Population of these fields occurs at per-tile sites in decode-level.ts and tiled-decode-pool.ts (deferred).
   */
  decodeMs?: number;
  bytesDecoded?: number;
}

export interface DecodeOptions {
  parallel?: boolean;
  decodeRegion?: RegionDecoder;
  signal?: AbortSignal;
  workerFactory?: () => WorkerLike;
  /** Explicit pool for parallel tiled decode (duck-typed; see PyramidPoolLike). */
  pool?: PyramidPoolLike;
  /** Opt-in decoded viewport cache (keyed by level+region+format; no auto persistence). */
  cache?: PyramidCache;
  /** Caller-owned recyclable buffer for stitched result (must be >= w*h*bpp). Returned .pixels will be this buffer on use. */
  outBuffer?: Uint8Array;
  /** If true, cache hits may return the cached Uint8Array directly (zero-copy). Default false (copies for safety). */
  zeroCopyCacheHits?: boolean;
  /** Called after each tile write (parallel) or once for direct (completedCount = tiles done).
   *  Third arg (TileProgress) supplied on new calls for F7 telemetry/identity; two-arg callers remain compatible. */
  onTile?: (region: ImageRegion, completedCount: number, progress?: TileProgress) => void;
  // F2 note: outBuffer + onTile together enable Grok 4 stream-stitch (on-arrival writes into caller buffer,
  // no results[] retention, paint as tiles land, reuse buffer across pans for 60fps). See decodeTiledViewport + decodeTilesParallel.
  /**
   * L20-1: when 'skip-tile', per-tile errors in progressive direct path zero the tile rect and continue; failedTiles populated on result.
   * Cache contract: results carrying failedTiles?.length > 0 represent partial viewports (zero-filled holes). Callers and
   * any cache layer using viewportCacheKey(..., 'final') must not store such results as complete final pixels; doing so
   * would serve zeroed tiles as authoritative on subsequent hits (cache poisoning). The progressive direct path in
   * decodeTiledViewport already elides the cache.set when failedTiles is non-empty. Pooled paths do not implement
   * skip-tile (they fail-fast the batch). This field documents the invariant for all consumers of DecodeOptions + DecodedLevel.
   */
  errorPolicy?: 'fail-fast' | 'skip-tile';
  /** L20-2: wall-clock budget for the decodeLevel call (checked in progressive per-tile loops for direct path). */
  budgetMs?: number;
  /** L4-4: resume-after-abort support; skip these tile keys (tileKey format) during progressive per-tile decode. */
  skipTiles?: ReadonlySet<string>;
  /**
   * Progressive DC-then-final first-paint (F1, cites L3m-2 L21m-2 L8pm-3).
   * When set, per-tile (or viewport) uses createDecoder({ progressionTarget: 'dc' }) for fast coarse paint,
   * then a second pass to final at the same level/region. Caller's onTile fires twice per tile.
   * Wired to stream-stitch (Grok 4): caller paints DC tiles first, then refines.
   * Undefined (default) = existing one-shot final behavior (no behavior change for happy path).
   */
  progressive?: Exclude<ProgressiveMode, undefined>;
}

export type ProgressiveMode = 'dc-then-final' | undefined;

/**
 * Scheduler boundary documentation (P3, Lens 1/19).
 * decode-core's WorkerLike + PyramidPoolLike (and the tiled worker pool in tiled-decode-pool.ts) are for the
 * JXTC *synchronous region/tile decode* path: small fixed grids of tiles, direct libjxl ROI or per-tile worker
 * calls, stream-stitch writes, optional dc-then-final progressive. This is intentionally separate from the
 * jxl-scheduler / jxl-session streaming protocol (chunked progressive full-codestream sessions with preemption,
 * DedupeRegistry fan-out, adaptive HWM backpressure, and pause/resume). Both may create WASM-backed workers,
 * but they are different workloads (random viewport tiles vs sequential byte-stream decode). Cross-pool CPU/core
 * oversubscription is governed by CoreBudget (sched-1) on the scheduler side only. No unification of the two
 * pools is planned in the current architecture; they remain distinct by design.
 */

/** Worker-like handle accepted by the pyramid pool (duck-typed; matches browser Worker + test doubles). See module comment above for scheduler boundary. */
export interface WorkerLike {
  addEventListener(
    type: "message" | "error" | "messageerror",
    listener: (ev: { data?: any }) => void,
  ): void;
  removeEventListener(
    type: "message" | "error" | "messageerror",
    listener: (ev: { data?: any }) => void,
  ): void;
  postMessage(data: any, transfer?: any[]): void;
  terminate(): void;
}

/**
 * Minimal structural (duck) type for DecodeOptions.pool.
 * Captures the exact members dereferenced by decodeTiledViewportPooled and shouldUseParallel
 * when an explicit pool is supplied (preferred over the module default singleton).
 * The concrete PyramidWorkerPool implementation lives in tiled-decode-pool.ts; this interface
 * lives here so decode-core (the types root) does not create a circular dependency.
 * Used only for the JXTC tiled/region fast path — intentionally separate from jxl-scheduler pools.
 */
export interface PyramidPoolLike {
  allocateBytesId(source: any): number;
  acquire(count: number, opts?: { maxWaitMs?: number }): Promise<any[]>;
  release(handles: any[]): void;
  readonly requestTimeout?: number;
  // Lifecycle surface for holders that manage the pool outside a single decode call.
  destroy?(graceMs?: number): Promise<void> | void;
  readonly destroyed?: boolean;
  readonly poolState?: string;
  prewarm?(count: number): void;
}

/** Init/options bag passed to jxl-wasm createDecoder (local name for cast sites; structural). */
export interface DecoderInit {
  format: PixelFormat;
  progressionTarget: 'header' | 'dc' | 'pass' | 'final';
  emitEveryPass: boolean;
  preserveIcc: boolean;
  preserveMetadata: boolean;
}
