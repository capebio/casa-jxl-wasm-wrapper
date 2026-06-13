// PSNR/SSIM on RGBA/any-channel u8 pixel buffers (len must == w*h*ch). Layout assumed packed contiguous.
// 0-len -> Infinity (psnr) / 0 (ssim). For profiling early term cutoffs vs final only.
export function computePsnrVsFinal(cutoffPixels, finalPixels) {
  if (cutoffPixels.length !== finalPixels.length) {
    throw new Error(`PSNR length mismatch: ${cutoffPixels.length} vs ${finalPixels.length}`);
  }
  let sumSq = 0;
  for (let i = 0; i < cutoffPixels.length; i++) {
    const d = cutoffPixels[i] - finalPixels[i];
    sumSq += d * d;
  }
  if (sumSq === 0) return Infinity;
  const mse = sumSq / cutoffPixels.length;
  return 10 * Math.log10((255 * 255) / mse);
}

export const C1 = (0.01 * 255) ** 2;
export const C2 = (0.03 * 255) ** 2;

// computeSsimVsFinal: global (image-wide) channel-averaged SSIM approximation using raw moments.
// No local windows (unlike classic SSIM 8x8+). Fast for cutoff profiling. Use external lib for full SSIM.
// series can carry butter/ssim for future unified recog (Lens12); color constancy metrics feed same shape.
export function computeSsimVsFinal(cutoffPixels, finalPixels, width, height) {
  if (cutoffPixels.length !== finalPixels.length) {
    throw new Error(`SSIM length mismatch: ${cutoffPixels.length} vs ${finalPixels.length}`);
  }
  const np = width * height;
  if (np === 0) return 0;
  const channels = cutoffPixels.length / np;
  if (!Number.isInteger(channels)) {
    throw new Error(`SSIM pixel count not divisible by ${width}*${height}`);
  }
  const windowChannels = Math.min(channels, 3);
  // Single fused pass accumulating raw moments per channel. uint8 products are
  // integers, so f64 sums stay exact up to 2^53 — no cancellation risk when
  // deriving var/cov from E[x^2] - mu^2 below.
  const sumA = [0, 0, 0], sumB = [0, 0, 0];
  const sumAA = [0, 0, 0], sumBB = [0, 0, 0], sumAB = [0, 0, 0];
  if (windowChannels === 3) {
    let sA0 = 0, sB0 = 0, sAA0 = 0, sBB0 = 0, sAB0 = 0;
    let sA1 = 0, sB1 = 0, sAA1 = 0, sBB1 = 0, sAB1 = 0;
    let sA2 = 0, sB2 = 0, sAA2 = 0, sBB2 = 0, sAB2 = 0;
    for (let i = 0, j = 0; i < np; i++, j += channels) {
      const a0 = cutoffPixels[j], b0 = finalPixels[j];
      const a1 = cutoffPixels[j + 1], b1 = finalPixels[j + 1];
      const a2 = cutoffPixels[j + 2], b2 = finalPixels[j + 2];
      sA0 += a0; sB0 += b0; sAA0 += a0 * a0; sBB0 += b0 * b0; sAB0 += a0 * b0;
      sA1 += a1; sB1 += b1; sAA1 += a1 * a1; sBB1 += b1 * b1; sAB1 += a1 * b1;
      sA2 += a2; sB2 += b2; sAA2 += a2 * a2; sBB2 += b2 * b2; sAB2 += a2 * b2;
    }
    sumA[0] = sA0; sumB[0] = sB0; sumAA[0] = sAA0; sumBB[0] = sBB0; sumAB[0] = sAB0;
    sumA[1] = sA1; sumB[1] = sB1; sumAA[1] = sAA1; sumBB[1] = sBB1; sumAB[1] = sAB1;
    sumA[2] = sA2; sumB[2] = sB2; sumAA[2] = sAA2; sumBB[2] = sBB2; sumAB[2] = sAB2;
  } else {
    for (let i = 0, j = 0; i < np; i++, j += channels) {
      for (let c = 0; c < windowChannels; c++) {
        const a = cutoffPixels[j + c], b = finalPixels[j + c];
        sumA[c] += a; sumB[c] += b;
        sumAA[c] += a * a; sumBB[c] += b * b; sumAB[c] += a * b;
      }
    }
  }
  let sumSsim = 0;
  for (let c = 0; c < windowChannels; c++) {
    const muA = sumA[c] / np;
    const muB = sumB[c] / np;
    const varA = sumAA[c] / np - muA * muA;
    const varB = sumBB[c] / np - muB * muB;
    const cov = sumAB[c] / np - muA * muB;
    const num = (2 * muA * muB + C1) * (2 * cov + C2);
    const den = (muA * muA + muB * muB + C1) * (varA + varB + C2);
    sumSsim += num / den;
  }
  return windowChannels === 0 ? 0 : sumSsim / windowChannels;
}

export const MONOTONE_TOLERANCE_DB = 0.5;

export function detectMonotone(series, toleranceDb = MONOTONE_TOLERANCE_DB, opts = {}) {
  const { valueKey = 'psnr', lowerIsBetter = false } = opts;
  const regressions = [];
  let prev = lowerIsBetter ? Infinity : -Infinity;
  for (const entry of series) {
    const v = entry[valueKey];
    if (!Number.isFinite(v)) continue;
    const worse = lowerIsBetter ? (v > prev + toleranceDb) : (v < prev - toleranceDb);
    if (prev !== (lowerIsBetter ? Infinity : -Infinity) && worse) {
      regressions.push({ bytes: entry.bytes, dropDb: Number(Math.abs(prev - v).toFixed(2)) });
    }
    if (lowerIsBetter ? (v < prev) : (v > prev)) prev = v;
  }
  return { monotone: regressions.length === 0, regressions };
}

// Future: feed butter/ssim series (lower/higher better) via opts to detect for unified cutoff analysis.

// computeChannelMoments: cheap per-channel mu/var for surrogate features (lens12 LLM/plant recog).
// Zero extra alloc in hot path if caller provides outs. Useful side output for "will cutoff ID plant?" tiny model.
export function computeChannelMoments(pixels, width, height, maxCh = 3) {
  const np = width * height;
  if (np === 0) return [];
  const ch = Math.min(maxCh, (pixels.length / np) | 0);
  const mus = new Array(ch).fill(0);
  const vars = new Array(ch).fill(0);
  for (let c = 0; c < ch; c++) {
    let sum = 0, sum2 = 0;
    for (let i = c, j = 0; j < np; j++, i += (pixels.length / np) | 0) {
      const v = pixels[i];
      sum += v; sum2 += v * v;
    }
    const mu = sum / np;
    mus[c] = mu;
    vars[c] = sum2 / np - mu * mu;
  }
  return { mus, vars, ch };
}

