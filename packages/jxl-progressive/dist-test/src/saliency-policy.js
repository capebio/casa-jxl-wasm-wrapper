// packages/jxl-progressive/src/saliency-policy.ts
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
    if (confidence < confidenceThreshold)
        return false;
    return true;
}
/** Normalise pixel coordinates to the 0–1 range. */
export function normaliseCenter(cx, cy, imageWidth, imageHeight) {
    return { x: cx / imageWidth, y: cy / imageHeight };
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
    if (best === undefined || best.confidence < threshold)
        return null;
    return best;
}
//# sourceMappingURL=saliency-policy.js.map