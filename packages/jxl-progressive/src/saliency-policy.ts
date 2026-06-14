// packages/jxl-progressive/src/saliency-policy.ts
/** Outputs (when selected) populate ProgressiveManifest.saliency — the encode-side field that reaches clients. */

export type ImageType =
  | "portrait"
  | "product"
  | "macro"
  | "landscape"
  | "habitat"
  | "map"
  | "plate"
  | "herbarium"
  | "microscopy"
  | "diagnostic";

// These types have spatially distributed diagnostic detail — saliency encoding
// is counterproductive (spec §Saliency Fallback Rules).
const SALIENCY_DISABLED_TYPES = new Set<ImageType>([
  "map",
  "plate",
  "herbarium",
  "microscopy",
  "diagnostic",
]);

export interface ShouldUseSaliencyOpts {
  imageType: ImageType;
  /** Attention-centre confidence from 0 to 1. */
  confidence: number;
  /** Number of detected attention centres. */
  centerCount: number;
  /** Minimum confidence to enable saliency. Default 0.6. */
  confidenceThreshold?: number;
}

/** Returns true if attention-centre saliency encoding is appropriate. */
export function shouldUseSaliency(opts: ShouldUseSaliencyOpts): boolean {
  const { imageType, confidence, centerCount, confidenceThreshold = 0.6 } = opts;
  if (SALIENCY_DISABLED_TYPES.has(imageType)) return false;
  if (centerCount === 0) return false;
  if (!(confidence >= confidenceThreshold)) return false;
  return true;
}

/** Normalise pixel coordinates to the 0–1 range. */
export function normaliseCenter(
  cx: number,
  cy: number,
  imageWidth: number,
  imageHeight: number,
): { x: number; y: number } {
  if (!(imageWidth > 0) || !(imageHeight > 0)) {
    throw new RangeError(`[saliency-policy] invalid image dimensions ${imageWidth}x${imageHeight}`);
  }
  return { x: cx / imageWidth, y: cy / imageHeight };
}

/**
 * From multiple attention centres, pick the single best.
 * Returns null if no centre meets the confidence threshold.
 */
export function selectBestCenter(
  centers: Array<{ x: number; y: number; confidence: number }>,
  opts?: { threshold?: number },
): { x: number; y: number; confidence: number } | null {
  const threshold = opts?.threshold ?? 0.6;
  if (centers.length === 0) return null;
  const sorted = [...centers].sort((a, b) => b.confidence - a.confidence);
  const best = sorted[0];
  if (best === undefined || !(best.confidence >= threshold)) return null;
  return best;
}

// --- Normalized Saliency (Phase 6 / P2 schema alignment) ---
// Legacy normaliseCenter/selectBestCenter remain {x,y} for compat (saliency.test.ts assertions).
// New *ToManifest / toSaliency produce the exact manifest shape {centerX, centerY, enabled, method}.

export interface Saliency {
  centerX: number; // normalised 0-1
  centerY: number;
  enabled: boolean;
  method: string;
  confidence?: number;
}

/** Map pixel centre to manifest {centerX, centerY}. */
export function normaliseCenterToManifest(
  cx: number,
  cy: number,
  imageWidth: number,
  imageHeight: number,
): { centerX: number; centerY: number } {
  const n = normaliseCenter(cx, cy, imageWidth, imageHeight);
  return { centerX: n.x, centerY: n.y };
}

/** Select best attention centre; return in manifest {centerX,centerY,confidence} form. */
export function selectBestCenterForManifest(
  centers: Array<{ x: number; y: number; confidence: number }>,
  opts?: { threshold?: number },
): { centerX: number; centerY: number; confidence: number } | null {
  const best = selectBestCenter(centers, opts);
  if (!best) return null;
  return { centerX: best.x, centerY: best.y, confidence: best.confidence };
}

/**
 * Compose a ProgressiveManifest-compatible saliency record from a centre (legacy or normalized).
 * Used by writers / profile callers to eliminate {x,y} vs {centerX,centerY} drift.
 * Callers: profileJxl(..., { saliency: toSaliency(bestCenter) })
 */
export function toSaliency(
  center: { x: number; y: number } | { centerX: number; centerY: number } | null,
  method = "attention",
  opts: { enabled?: boolean; confidence?: number } = {},
): Saliency | undefined {
  if (!center) return undefined;
  const cx = "centerX" in center ? center.centerX : (center as any).x;
  const cy = "centerY" in center ? center.centerY : (center as any).y;
  if (typeof cx !== "number" || typeof cy !== "number") return undefined;
  return {
    centerX: cx,
    centerY: cy,
    enabled: opts.enabled ?? true,
    method,
    ...(opts.confidence !== undefined ? { confidence: opts.confidence } : {}),
  };
}
