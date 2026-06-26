// packages/jxl-progressive/src/progressive-metrics.ts
export type MetricName = "ssim" | "psnr" | "butteraugli";

/** A scorer compares a candidate RGBA8 frame against a reference RGBA8 frame
 *  of the same dimensions and returns a scalar. Async to allow wasm-backed scorers. */
export type MetricScorer = {
  metric: MetricName;
  score: (candidate: Uint8Array, reference: Uint8Array, w: number, h: number) => Promise<number>;
};

/** PSNR in dB of `candidate` vs `reference` (RGBA8, alpha ignored). Higher is better. */
export function psnrVsRef(candidate: Uint8Array, reference: Uint8Array): number {
  const n = Math.min(candidate.length, reference.length);
  let sumSq = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    if ((i & 3) === 3) continue; // skip alpha
    const d = candidate[i]! - reference[i]!;
    sumSq += d * d;
    count++;
  }
  if (count === 0 || sumSq === 0) return Infinity;
  const mse = sumSq / count;
  return 10 * Math.log10((255 * 255) / mse);
}

/** Single-window global SSIM on luma of `candidate` vs `reference`. Higher is better (max 1). */
export function ssimVsRef(candidate: Uint8Array, reference: Uint8Array, w: number, h: number): number {
  const n = w * h;
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  let muX = 0, muY = 0;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    const lx = 0.299 * candidate[i]! + 0.587 * candidate[i + 1]! + 0.114 * candidate[i + 2]!;
    const ly = 0.299 * reference[i]! + 0.587 * reference[i + 1]! + 0.114 * reference[i + 2]!;
    muX += lx; muY += ly;
  }
  muX /= n; muY /= n;
  let vX = 0, vY = 0, cov = 0;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    const lx = 0.299 * candidate[i]! + 0.587 * candidate[i + 1]! + 0.114 * candidate[i + 2]!;
    const ly = 0.299 * reference[i]! + 0.587 * reference[i + 1]! + 0.114 * reference[i + 2]!;
    vX += (lx - muX) ** 2; vY += (ly - muY) ** 2; cov += (lx - muX) * (ly - muY);
  }
  const denomN = n - 1 || 1;
  vX /= denomN; vY /= denomN; cov /= denomN;
  return ((2 * muX * muY + C1) * (2 * cov + C2)) /
         ((muX * muX + muY * muY + C1) * (vX + vY + C2));
}

/** True when `value` is "good enough" for `metric` at `threshold`.
 *  ssim/psnr: higher is better. butteraugli: lower is better. */
export function meetsThreshold(metric: MetricName, value: number, threshold: number): boolean {
  if (metric === "butteraugli") return value <= threshold;
  return value >= threshold;
}
