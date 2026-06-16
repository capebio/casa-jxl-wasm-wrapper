// PSNR/SSIM on RGBA/any-channel u8 pixel buffers (len must == w*h*ch). Layout assumed packed contiguous.
// 0-len -> Infinity (psnr) / 0 (ssim). For profiling early term cutoffs vs final only.
/** @param {Uint8Array} cutoffPixels @param {Uint8Array} finalPixels @param {number} [peak=255] */
export function computePsnrVsFinal(cutoffPixels, finalPixels, peak = 255) {
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
  const peakSq = peak * peak;
  return 10 * Math.log10(peakSq / mse);
}

/** SSIM constants (8-bit). Rare expert tuning only; see JSDoc on computeSsimVsFinal. */
export const C1 = (0.01 * 255) ** 2;
export const C2 = (0.03 * 255) ** 2;

// computeSsimVsFinal: global (image-wide) channel-averaged SSIM approximation using raw moments.
// No local windows (unlike classic SSIM 8x8+). Fast for cutoff profiling. Use external lib for full SSIM.
// series can carry butter/ssim for future unified recog (Lens12); color constancy metrics feed same shape.
// TODO(lens17): when LookRenderer non-Riemann (Schrodinger+Molchanov+ HPCS + LANL curves, B-matrix log flat space) lands,
//   consider perceptual-space variant or document that caller must feed post-Look u8 for constancy-invariant metrics.
// Alpha: windowChannels = min(ch,3) — alpha dropped for perceptual uniformity. Pre-convert caller side if alpha matters.
/** @param {Uint8Array} cutoffPixels @param {Uint8Array} finalPixels @param {number} width @param {number} height */
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
// TODO(lens17,12,14,16): surrogate for AR plant ID, photogram digital twins, LLM recog gates. Run on post-LookRenderer
//   u8 (or future perceptual flat coords) once non-Riemann engine (B log + Molchanov tensor + LANL curves) active in Rust.
export function computeChannelMoments(pixels, width, height, maxCh = 3, outs) {
  const np = width * height;
  if (np === 0) return outs ? (outs.mus && (outs.mus.length = 0), outs.vars && (outs.vars.length = 0), outs.ch = 0, outs) : [];
  const lenOverNp = pixels.length / np;
  if (!Number.isInteger(lenOverNp)) {
    throw new Error(`Channel moments pixel count not divisible by ${width}*${height}`);
  }
  const stride = lenOverNp | 0;
  const ch = Math.min(maxCh, stride);
  // stride hoisted (was recomputed per-iter); pointer-advance pattern (i += stride). Matches "move pointer not reread".
  // SIMD note (lens22,25,26): tight data-parallel u8 loops (psnr sumSq; ssim muls; here strided per-c). 8-16 px/vector.
  const mus = outs ? (outs.mus || (outs.mus = new Array(ch).fill(0))) : new Array(ch).fill(0);
  const vars = outs ? (outs.vars || (outs.vars = new Array(ch).fill(0))) : new Array(ch).fill(0);
  for (let c = 0; c < ch; c++) {
    let sum = 0, sum2 = 0;
    for (let i = c, j = 0; j < np; j++, i += stride) {
      const v = pixels[i];
      sum += v; sum2 += v * v;
    }
    const mu = sum / np;
    mus[c] = mu;
    vars[c] = sum2 / np - mu * mu;
  }
  if (outs) { outs.ch = ch; return outs; }
  return { mus, vars, ch };
}

// Fused bundle (layer1): one/two-pass multi-metric to avoid 3x pixel scan + repeated materialization (lens20,24,6).
// Returns same shape as separate calls. Callers (profiling/AR gate) get psnr+ssim+moments for "cutoff quality + recog features".
// No behavior change to prior exports. Wire in callers outside this file only if positive on re-assess.
export function computeQualityBundle(cutoffPixels, finalPixels, width, height) {
  const psnr = computePsnrVsFinal(cutoffPixels, finalPixels);
  const ssim = computeSsimVsFinal(cutoffPixels, finalPixels, width, height);
  const moments = computeChannelMoments(cutoffPixels, width, height); // or fuse accumulators internally if hotter needed
  return { psnr, ssim, moments };
}

// Thin plateau helper (layer4): combines existing detect + moments for "good enough for recog/AR/photogram?" decision surface.
// Keep tiny; defers policy to callers (unified layer gap remains per lens18/19).
export function isQualityPlateau(series, opts = {}) {
  const res = detectMonotone(series, opts.tol, { valueKey: opts.valueKey || 'psnr' });
  return res.monotone;
}

