/** libjxl quality->distance: distance = 0.1 + (100 - q) * 0.09, with q=100 lossless (0). */
export function qualityToDistance(quality) {
    if (quality >= 100)
        return 0;
    if (quality < 30) {
        throw new Error(`quality ${quality} out of range: libjxl distance mapping requires q >= 30`);
    }
    return 0.1 + (100 - quality) * 0.09;
}
export const EFFORT = 3;
export const GRID_QUALITY = 85;
export const BIG_QUALITY = 95;
export const PROXY_QUALITY = 85;
export const LEVEL_SIZES = [256, 512, 1024, 2048];
const BIG_SIZES = new Set([2048]);
export function planLadder() {
    const gridDistance = qualityToDistance(GRID_QUALITY);
    const bigDistance = qualityToDistance(BIG_QUALITY);
    return {
        sidecarSizes: [...LEVEL_SIZES],
        sidecarDistances: LEVEL_SIZES.map((s) => (BIG_SIZES.has(s) ? bigDistance : gridDistance)),
        fullDistance: bigDistance,
        effort: EFFORT,
    };
}
export function planProxy(size) {
    const d = qualityToDistance(PROXY_QUALITY);
    return { sidecarSizes: [size], sidecarDistances: [d], fullDistance: d, effort: EFFORT };
}
//# sourceMappingURL=quality.js.map