import type { PyramidEncodeOptions } from "./backends.js";

/** libjxl quality->distance: distance = 0.1 + (100 - q) * 0.09, with q=100 lossless (0).
 * low-quality-discontinuity: we clamp to int; 99.5+ becomes 100 (lossless). Pixel det holds; byte may differ vs float path.
 */
export function qualityToDistance(quality: number): number {
  if (quality > 100) {
    throw new Error(`quality ${quality} out of range: >100 not supported`);
  }
  quality = Math.round(quality);
  if (quality >= 100) return 0;
  if (quality < 30) {
    throw new Error(`quality ${quality} out of range: libjxl distance mapping requires q >= 30`);
  }
  return 0.1 + (100 - quality) * 0.09;
}

export const EFFORT = 3;
export const GRID_QUALITY = 85;
export const BIG_QUALITY = 95;
export const PROXY_QUALITY = 85;

/** D1/F9: Byte-determinism guaranteed only with --encoder-threads 1 (forces non-MT tier).
 * Production default multi-threaded (mt tiers) for speed. Pixel-determinism (PSNR > 60 dB vs ref) holds either way.
 * libjxl internal thread sched affects bitstream at effort>=3 in MT.
 */


export const LEVEL_SIZES = [256, 512, 1024, 2048] as const;
const BIG_SIZES = new Set<number>([2048]);

export function planLadder(): PyramidEncodeOptions {
  const gridDistance = qualityToDistance(GRID_QUALITY);
  const bigDistance = qualityToDistance(BIG_QUALITY);
  const sidecars = LEVEL_SIZES.map((s) => ({
    size: s,
    distance: BIG_SIZES.has(s) ? bigDistance : gridDistance,
  }));
  return {
    sidecars,
    fullDistance: bigDistance,
    effort: EFFORT,
  };
}

export function planProxy(size: number): PyramidEncodeOptions {
  const d = qualityToDistance(PROXY_QUALITY);
  return { sidecars: [{ size, distance: d }], fullDistance: d, effort: EFFORT };
}