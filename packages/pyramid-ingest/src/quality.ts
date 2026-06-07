import type { PyramidEncodeOptions } from "./backends.js";

/** libjxl quality->distance: distance = 0.1 + (100 - q) * 0.09, with q=100 lossless (0). */
export function qualityToDistance(quality: number): number {
  if (quality >= 100) return 0;
  if (quality < 30) {
    throw new Error(`quality ${quality} out of range: libjxl distance mapping requires q >= 30`);
  }
  return 0.1 + (100 - quality) * 0.09;
}

export const EFFORT = 3; // memory: effort 3 best on speed + filesize
export const GRID_QUALITY = 85;
export const BIG_QUALITY = 95;
export const PROXY_QUALITY = 85;

/** Long-edge targets, ascending. Sizes >= the master long edge are skipped by the encoder. */
export const LEVEL_SIZES = [256, 512, 1024, 2048] as const;
/** Sizes that get the higher (q95) distance; the rest get q85. */
const BIG_SIZES = new Set<number>([2048]);

/** The full RAW/JPG ladder plan: grid sizes at q85, the 2048 big level + full at q95. */
export function planLadder(): PyramidEncodeOptions {
  const gridDistance = qualityToDistance(GRID_QUALITY);
  const bigDistance = qualityToDistance(BIG_QUALITY);
  return {
    sidecarSizes: [...LEVEL_SIZES],
    sidecarDistances: LEVEL_SIZES.map((s) => (BIG_SIZES.has(s) ? bigDistance : gridDistance)),
    fullDistance: bigDistance,
    effort: EFFORT,
  };
}

/** Proxy plan: one q85 level at `size` (verification probe). */
export function planProxy(size: number): PyramidEncodeOptions {
  const d = qualityToDistance(PROXY_QUALITY);
  return { sidecarSizes: [size], sidecarDistances: [d], fullDistance: d, effort: EFFORT };
}
