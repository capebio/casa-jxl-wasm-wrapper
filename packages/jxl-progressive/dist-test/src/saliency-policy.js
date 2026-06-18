// packages/jxl-progressive/src/saliency-policy.ts
/** Outputs (when selected) populate ProgressiveManifest.saliency — the encode-side field that reaches clients. */
// These types have spatially distributed diagnostic detail — saliency encoding
// is counterproductive (spec §Saliency Fallback Rules).
const SALIENCY_DISABLED_TYPES = new Set([
    "map",
    "plate",
    "herbarium",
    "microscopy",
    "diagnostic",
]);
/** Returns true if attention-centre saliency encoding is appropriate. */
export function shouldUseSaliency(opts) {
    const { imageType, confidence, centerCount, confidenceThreshold = 0.6 } = opts;
    if (SALIENCY_DISABLED_TYPES.has(imageType))
        return false;
    if (centerCount === 0)
        return false;
    if (!(confidence >= confidenceThreshold))
        return false;
    return true;
}
/** Normalise pixel coordinates to the 0–1 range. */
export function normaliseCenter(cx, cy, imageWidth, imageHeight) {
    if (!(imageWidth > 0) || !(imageHeight > 0)) {
        throw new RangeError(`[saliency-policy] invalid image dimensions ${imageWidth}x${imageHeight}`);
    }
    const clamp = (v) => Math.min(1, Math.max(0, v));
    return { x: clamp(cx / imageWidth), y: clamp(cy / imageHeight) };
}
/**
 * From multiple attention centres, pick the single best.
 * Returns null if no centre meets the confidence threshold.
 */
export function selectBestCenter(centers, opts) {
    const threshold = opts?.threshold ?? 0.6;
    if (centers.length === 0)
        return null;
    const sorted = [...centers].sort((a, b) => b.confidence - a.confidence);
    const best = sorted[0];
    if (best === undefined || !(best.confidence >= threshold))
        return null;
    return best;
}
/** Map pixel centre to manifest {centerX, centerY}. */
export function normaliseCenterToManifest(cx, cy, imageWidth, imageHeight) {
    const n = normaliseCenter(cx, cy, imageWidth, imageHeight);
    return { centerX: n.x, centerY: n.y };
}
/** Select best attention centre; return in manifest {centerX,centerY,confidence} form. */
export function selectBestCenterForManifest(centers, opts) {
    const best = selectBestCenter(centers, opts);
    if (!best)
        return null;
    return { centerX: best.x, centerY: best.y, confidence: best.confidence };
}
/**
 * Compose a ProgressiveManifest-compatible saliency record from a centre (legacy or normalized).
 * Used by writers / profile callers to eliminate {x,y} vs {centerX,centerY} drift.
 * Callers: profileJxl(..., { saliency: toSaliency(bestCenter) })
 */
export function toSaliency(center, method = "attention", opts = {}) {
    if (!center)
        return undefined;
    const cx = "centerX" in center ? center.centerX : center.x;
    const cy = "centerY" in center ? center.centerY : center.y;
    if (typeof cx !== "number" || typeof cy !== "number")
        return undefined;
    return {
        centerX: cx,
        centerY: cy,
        enabled: opts.enabled ?? true,
        method,
        confidence: opts.confidence ?? 0,
    };
}
//# sourceMappingURL=saliency-policy.js.map