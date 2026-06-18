// packages/jxl-progressive/src/types.ts
// Shared types for @casabio/jxl-progressive.

import type { DecodeSession } from "@casabio/jxl-session";

export type { DecodeSession };

/**
 * Factory function that returns a fresh DecodeSession configured for
 * progressive decode (emitEveryPass: true, progressionTarget: "final").
 * Used by profileJxl and ProgressiveGallery.
 */
export type SessionFactory = () => DecodeSession;

// --- AI / Model Hooks (Phase 6 P7 A10) ---
// ModelAdapter provides zero-copy interception points for ML pipelines over
// progressive tile streams. onTile yields exact decoded regions (no main-thread
// full-res decode or extra resize for model input sizes).

export interface LevelDescriptor {
  width: number;
  height: number;
  byteEnd?: number;
  tier?: string;
}

export interface Roi {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ScreenPoint { x: number; y: number; }
export interface ImagePoint { x: number; y: number; }

/**
 * Standard adapter surface for feeding progressive decodes into classifiers,
 * detectors, embedders without forcing full image materialization.
 */
export interface ModelAdapter {
  onFrame?(frame: { stage: string; info: unknown; pixels?: ArrayBuffer | Uint8Array }): void | Promise<void>;
  /** bmp: pixels for the tile (ArrayBuffer/Uint8Array or ImageBitmap). bbox: image-space. tier: dc|preview|full etc. */
  onTile(
    bmp: ArrayBuffer | Uint8Array | ImageBitmap,
    bbox: { x: number; y: number; w: number; h: number },
    tier: string,
  ): void | Promise<void>;
  onEmbedding?(embedding: Float32Array, meta?: Record<string, unknown>): void | Promise<void>;
}

/**
 * Select the pyramid/level whose dimensions best match a model input size (e.g. 224 or 512).
 * Guarantees caller can use the decoded tile at native model res with zero additional resize
 * and without ever decoding higher-res levels than needed.
 */
export function pickModelLevel(
  levels: readonly LevelDescriptor[],
  inputPx: number,
): LevelDescriptor | undefined {
  if (!levels || levels.length === 0 || !Number.isFinite(inputPx) || inputPx <= 0) return undefined;
  let best: LevelDescriptor | undefined;
  let bestScore = Infinity;
  for (const lv of levels) {
    const size = Math.max(lv.width, lv.height);
    const diff = Math.abs(size - inputPx);
    // Prefer exact or larger; small penalty for undersize (would require model-side upsample or pad)
    const penalty = size < inputPx ? 1000 : 0;
    const score = diff + penalty;
    if (score < bestScore) {
      bestScore = score;
      best = lv;
    }
  }
  return best;
}

/**
 * Map full-res image coords to screen under active level + optional ROI.
 * scaleX/scaleY computed separately to support anamorphic (non-square-pixel) content (B6).
 */
export function toScreenCoords(
  pt: ImagePoint,
  level: LevelDescriptor,
  roi?: Roi,
  screenScale?: { scaleX?: number; scaleY?: number },
): ScreenPoint {
  const bw = level.width || 1;
  const bh = level.height || 1;
  const sx = screenScale?.scaleX ?? (roi ? roi.w / bw : 1);
  const sy = screenScale?.scaleY ?? (roi ? roi.h / bh : 1);
  const ox = roi?.x ?? 0;
  const oy = roi?.y ?? 0;
  return { x: (pt.x - ox) * sx, y: (pt.y - oy) * sy };
}

/** Inverse: screen -> image (full-res pixels). Separate scales for anamorphic correctness. */
export function toImageCoords(
  pt: ScreenPoint,
  level: LevelDescriptor,
  roi?: Roi,
  screenScale?: { scaleX?: number; scaleY?: number },
): ImagePoint {
  const bw = level.width || 1;
  const bh = level.height || 1;
  const sx = screenScale?.scaleX ?? (roi ? roi.w / bw : 1);
  const sy = screenScale?.scaleY ?? (roi ? roi.h / bh : 1);
  const ox = roi?.x ?? 0;
  const oy = roi?.y ?? 0;
  return { x: pt.x / sx + ox, y: pt.y / sy + oy };
}

// --- Phase 8: Bursts, Capture Geometries & 3D Twins (ST1, BD2, PG2, PG5, ST8, BD5, RC2, BD4, BD6, BD7, PG4) ---
// Schema lives primarily here per handoff (types.ts) + progressive-manifest.ts for ProgressiveManifest reserves.
// FrameSet generalizes single progressive JXLs into coordinate-transformable multi-frame sets.
// Heavy CV (SfM, SIFT, MVS) remains in pyramid-ingest. This package owns only progressive schema + decode interfaces.

// Relation between coordinated capture members (bursts use I/P delta coding; transects are pushbroom).
export type Relation = "Burst" | "Timelapse" | "Panorama" | "Transect" | "Photogrammetry";

// Role flag for delta relations (BD-trap): deltas predict only from one designated base keyframe. No delta chains.
export type FrameRole = "key" | "delta";

export interface CameraPose {
  lat: number;
  lon: number;
  alt: number;
  yaw: number;
  pitch: number;
  roll: number;
  timestamp: number; // epoch ms
}

export interface FrameSetMember {
  id: string;
  jxlUrl: string;
  pose?: CameraPose;
  role?: FrameRole;
  /** baseId designates the key member for residual reconstruction (delta only predicts from this base). */
  baseId?: string;
  /** DC tier sha256 override. When identical across burst members, enables single fetch + shared render (BD4/BD6 via Phase 5 cache). */
  dcSha256?: string;
  /** Reserved: pinhole intrinsics (PG2). */
  intrinsics?: {
    fx: number;
    fy: number;
    cx: number;
    cy: number;
    skew?: number;
    dist?: number[]; // k1,k2,p1,p2,k3...
  };
  /** Reserved: extrinsics / pose matrix components (PG2). */
  extrinsics?: {
    r: number[]; // quat [w,x,y,z] or 9-elem rotmat row-major
    t: [number, number, number];
  };
  /** Reserved: depth layer descriptor for multi-layer / transect (ST8, PG4). */
  depthLayer?: {
    url?: string;
    sha256?: string;
    units?: "meters" | "normalized" | string;
    scale?: number;
    offset?: number;
  };
  /** Reserved: content-addressed SHA256 for scale-invariant feature sidecar (SIFT etc, PG5). */
  featureSidecar?: string;
}

export interface FrameSet {
  id: string;
  relation: Relation;
  members: FrameSetMember[];
  /** Shared DC tier sha enables burst thumbnail dedupe at manifest.jxl level for lowest tier. */
  sharedDcSha256?: string;
}

// --- Keyframe + Residual Decode Semantics (BD5, RC2) ---
// BurstGroup controller reuses Phase 5 unified cache for base keyframe buffer (1/N cost for burst).
// compose is the delta reconstruction: residual (decoded delta JXL) + base (keyframe pixels) -> final.
// Impl of cache lookup + scheduling is outside this module (scheduler/decode-handler boundary).

export interface BurstGroup {
  readonly baseId: string;
  readonly deltaIds: readonly string[];
  /** Fetch decoded base (ArrayBuffer of pixels) via cache key (manifest sha or jxlUrl of the key member). */
  getBaseBuffer(): Promise<ArrayBuffer | null>;
  /** Reconstruct one delta frame. */
  compose(base: ArrayBuffer, residual: ArrayBuffer): ArrayBuffer;
}

export type ComposeBurstFrame = (base: ArrayBuffer, residual: ArrayBuffer) => ArrayBuffer;

// Default compose: simple per-byte add with clamp (for intensity residual or canvas delta draw prep).
// Real pipelines may do YCbCr add, optical flow warp, or canvas putImageData diff.
export function defaultComposeBurstFrame(base: ArrayBuffer, residual: ArrayBuffer): ArrayBuffer {
  const b = new Uint8Array(base);
  const r = new Uint8Array(residual);
  const out = new Uint8Array(Math.max(b.length, r.length));
  const len = Math.min(b.length, r.length);
  for (let i = 0; i < len; i++) {
    const v = b[i]! + r[i]!;
    out[i] = v > 255 ? 255 : v;
  }
  if (b.length > len) out.set(b.subarray(len), len);
  else if (r.length > len) out.set(r.subarray(len), len);
  return out.buffer;
}

// --- Laplacian Sharpness Auto-Ranking (BD7) ---
// Variance-of-Laplacian proxy on luma for auto cover selection (argmax for burst card keyframe).
// Placed here (shared types) rather than saliency-policy.ts to obey mandatory commit scope (only edit manifest+types).
// See Deferred.md for rationale. Consumers / future saliency can call this on DC luma.

export function getSharpnessRank(lumaArray: Uint8Array, width: number, height: number): number {
  if (!lumaArray || width < 3 || height < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  // 4-neighbor Laplace (fast proxy, no extra allocs). Matches "variance-of-Laplacian convolution".
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const lap = (lumaArray[i]! << 2) - lumaArray[i - 1]! - lumaArray[i + 1]! - lumaArray[i - width]! - lumaArray[i + width]!;
      sum += lap;
      sumSq += lap * lap;
      count++;
    }
  }
  if (count === 0) return 0;
  const mean = sum / count;
  return (sumSq / count) - (mean * mean);
}

/** argmax(sharpness) helper: returns index of sharpest member (for appointing burst cover). */
export function argmaxSharpness<T extends { luma?: Uint8Array; width?: number; height?: number; sharpness?: number }>(
  candidates: readonly T[],
): number {
  if (!candidates || candidates.length === 0) return -1;
  let bestIdx = 0;
  let best = -Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    let s = c.sharpness;
    if (s === undefined && c.luma && c.width && c.height) s = getSharpnessRank(c.luma, c.width, c.height);
    if ((s ?? -Infinity) > best) {
      best = s ?? -Infinity;
      bestIdx = i;
    }
  }
  return bestIdx;
}

// --- Depth, Normal & Confidence Channel Semantics (PG4) ---
// Extra channels load concurrently with RGB in progressive asset stream.
export type AssetChannel = "rgb" | "depth" | "normal" | "confidence";

export interface ChannelDescriptor {
  channel: AssetChannel;
  /** Optional per-channel metadata (scale, bias, confidence threshold, normal encoding). */
  meta?: Record<string, unknown>;
}

// --- Streaming AI helpers (surface only; full pipeline integration deferred per layer rules) ---

/**
 * Basic tile sort comparator for saliency-ordered fetching (F35/C2).
 * Use as: [...tiles].sort(saliencyTileComparator(saliencyCenter))
 * Computes squared distance of tile center to manifest saliency center.
 * Actual queue wiring lives in scheduler/stream (skipped here to confine edits to allowed files).
 */
export function saliencyTileComparator(
  saliency?: { centerX: number; centerY: number },
): (a: { cx: number; cy: number }, b: { cx: number; cy: number }) => number {
  if (!saliency) return () => 0;
  const { centerX, centerY } = saliency;
  return (a, b) => {
    const da = (a.cx - centerX) ** 2 + (a.cy - centerY) ** 2;
    const db = (b.cx - centerX) ** 2 + (b.cy - centerY) ** 2;
    return da - db;
  };
}

/**
 * detectWhileStreaming: feed progressive tiles to detector/adapter; early exit on high confidence.
 * Consumer usage (example, no core change here):
 *   for await (const t of detectWhileStreaming(tileSource, detector, () => session.cancel())) { ... }
 * The cancel() must be wired to the actual source (DecodeSession / fetch controller) to reject
 * iterator and release decoder slot (B5 contract). Full auto-wiring of iterator reject deferred.
 */
export async function detectWhileStreaming(
  tiles: AsyncIterable<{ bmp: ArrayBuffer | Uint8Array | ImageBitmap; bbox: { x: number; y: number; w: number; h: number }; tier: string }>,
  detector: (bmp: any, bbox: any, tier: string) => { confidence?: number; localized?: boolean } | void | Promise<any>,
  cancel?: () => void | Promise<void>,
  opts: { confidenceThreshold?: number } = {},
): Promise<void> {
  const threshold = opts.confidenceThreshold ?? 0.8;
  for await (const tile of tiles) {
    const res: any = await detector(tile.bmp, tile.bbox, tile.tier);
    const conf = res?.confidence ?? (res?.localized ? 0.99 : 0);
    if (conf >= threshold) {
      if (cancel) await cancel();
      break; // early exit; upstream cancel should make subsequent next() throw/reject
    }
  }
}

/**
 * ID-Budget Auto-Stop hook (N1).
 * Extension point: when model confidence crosses threshold during streaming, signal "sharp enough".
 * Callers integrate into their fetch/decode budget loop (e.g. if (autoStop(res)) { stream.end(); }).
 * No change to core termination in this confined edit.
 */
export function shouldAutoStopForModel(conf: number, threshold = 0.85): boolean {
  return Number.isFinite(conf) && conf >= threshold;
}
