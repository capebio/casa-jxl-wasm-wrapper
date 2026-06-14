import { detectMonotone, computePsnrVsFinal, computeSsimVsFinal } from './jxl-progressive-quality.js';
import { createButteraugliComparer } from './jxl-butteraugli.js';  // for buildSeries helper (cohesion)

export const RECOGNIZABLE_DB = 20;
export const PREVIEW_DB = 30;
export const GOOD_BUTTER = 1.0;
export const SSIM_GOOD = 0.8;
export const BUTTER_MONOTONE_TOL = 0.1;

export function classifyByteCutoffFrame({ bytes, events = [], error = null }) {
  const frames = events.filter((event) => event && (event.type === 'progress' || event.type === 'final'));
  const last = frames.at(-1);
  return {
    bytes,
    painted: frames.length > 0,
    frameCount: frames.length,
    isFinal: frames.some((event) => event.type === 'final'),
    stage: last?.stage ?? last?.type ?? null,
    error,
  };
}

export function summarizeByteCutoffResults(results, totalBytes, { qualitySeries = null, butterSeries = null, ssimSeries = null, goodButter = GOOD_BUTTER } = {}) {
  const sorted = ensureSorted(results);
  const painted = sorted.filter((result) => result.painted);
  const firstPaint = painted[0] ?? null;
  const final = sorted.find((result) => result.isFinal) ?? sorted.at(-1) ?? null;
  const maxFrameCount = sorted.reduce((max, result) => Math.max(max, result.frameCount ?? 0), 0);

  let firstRecognizableBytes = null;
  let previewBytes = null;
  let finalPsnr = null;
  let monotone = null;
  let regressions = [];

  if (Array.isArray(qualitySeries) && qualitySeries.length > 0) {
    const sortedSeries = ensureSorted(qualitySeries);
    firstRecognizableBytes = sortedSeries.find((entry) => entry.psnr >= RECOGNIZABLE_DB)?.bytes ?? null;
    previewBytes = sortedSeries.find((entry) => entry.psnr >= PREVIEW_DB)?.bytes ?? null;
    finalPsnr = sortedSeries.at(-1)?.psnr ?? null;
    const monotoneResult = detectMonotone(sortedSeries);
    monotone = monotoneResult.monotone;
    regressions = monotoneResult.regressions;
  } else {
    previewBytes = pickPreviewCutoffBytesOnly(painted, totalBytes);
  }

  // perceptual-aware preview if butterSeries present (even without qualitySeries)
  if (previewBytes == null && Array.isArray(butterSeries) && butterSeries.length > 0) {
    const ss = ensureSorted(butterSeries);
    previewBytes = ss.find((e) => e.butter != null && e.butter <= goodButter)?.bytes ?? ss.at(-1)?.bytes ?? null;
  }

  let firstPerceptuallyGoodBytes = null;
  let firstPerceptuallyGoodPercent = null;
  let finalButter = null;
  let butterMonotone = null;
  let butterRegressions = [];

  if (Array.isArray(butterSeries) && butterSeries.length > 0) {
    const ss = ensureSorted(butterSeries);
    firstPerceptuallyGoodBytes = ss.find((e) => e.butter != null && e.butter <= goodButter)?.bytes ?? null;
    firstPerceptuallyGoodPercent = percent(firstPerceptuallyGoodBytes, totalBytes);
    finalButter = ss.at(-1)?.butter ?? null;
    const m = detectMonotone(ss.map((e) => ({ bytes: e.bytes, butter: e.butter })), BUTTER_MONOTONE_TOL, { valueKey: 'butter', lowerIsBetter: true });
    butterMonotone = m.monotone;
    butterRegressions = m.regressions;
  }

  // ssimSeries support for symmetry (higher-better like psnr); fields added if present
  let firstGoodSsimBytes = null, finalSsim = null, ssimMonotone = null, ssimRegressions = [];
  if (Array.isArray(ssimSeries) && ssimSeries.length > 0) {
    const ss = ensureSorted(ssimSeries);
    firstGoodSsimBytes = ss.find((e) => e.ssim != null && e.ssim >= SSIM_GOOD)?.bytes ?? null;
    finalSsim = ss.at(-1)?.ssim ?? null;
    const m = detectMonotone(ss.map((e) => ({ bytes: e.bytes, ssim: e.ssim })));
    ssimMonotone = m.monotone;
    ssimRegressions = m.regressions;
  }

  return {
    totalBytes,
    firstPaintBytes: firstPaint?.bytes ?? null,
    firstPaintPercent: percent(firstPaint?.bytes, totalBytes),
    firstRecognizableBytes,
    firstRecognizablePercent: percent(firstRecognizableBytes, totalBytes),
    previewBytes,
    previewPercent: percent(previewBytes, totalBytes),
    finalBytes: final?.bytes ?? null,
    finalPercent: percent(final?.bytes, totalBytes),
    finalPsnr,
    paintedCutoffs: painted.length,
    maxFrameCount,
    usefulEarlyPaint: !!firstPaint && firstPaint.bytes < totalBytes,
    monotone,
    regressions,
    firstPerceptuallyGoodBytes,
    firstPerceptuallyGoodPercent,
    finalButter,
    butterMonotone,
    butterRegressions,
    firstGoodSsimBytes,
    finalSsim,
    ssimMonotone,
    ssimRegressions,
  };
}

function ensureSorted(arr) {
  if (!Array.isArray(arr) || arr.length < 2) return arr || [];
  for (let i = 1; i < arr.length; i++) {
    if (arr[i].bytes < arr[i - 1].bytes) return [...arr].sort((a, b) => a.bytes - b.bytes);
  }
  return arr;
}

function pickPreviewCutoffBytesOnly(painted, totalBytes) {
  if (painted.length === 0) return null;
  const nonFinal = painted.filter((result) => !result.isFinal && result.bytes < totalBytes);
  if (nonFinal.length === 0) return painted[0]?.bytes ?? null;
  const threshold = Math.min(50 * 1024, Math.max(1, totalBytes * 0.7));
  return (nonFinal.find((result) => result.bytes >= threshold) ?? nonFinal.at(-1))?.bytes ?? null;
}

function percent(bytes, totalBytes) {
  if (bytes == null || !Number.isFinite(totalBytes) || totalBytes <= 0) return null;
  return Math.round((bytes / totalBytes) * 1000) / 10;
}

/**
 * Async buildSeries variant. Accepts a pre-inited comparator (e.g. ButteraugliComparator from
 * facade.ts) to reuse ref-cached WASM state across calls. Falls back to JS createButteraugliComparer
 * when opts.comparator not provided. Supports WASM PSNR/SSIM hooks via opts.psnrFn/ssimFn.
 *
 * opts.comparator  — object with .compare(pixels) → number (sync)
 * opts.psnrFn      — async (test, ref, w, h) → number | null  (WASM PSNR if available)
 * opts.ssimFn      — async (test, ref, w, h) → number | null  (WASM SSIM if available)
 * opts.postDecodeTransform — same signature as buildSeries
 */
export async function buildSeriesAsync(refPixels, cutoffPixelsList, byteSizes, width, height, opts = {}) {
  if (!Array.isArray(cutoffPixelsList) || !Array.isArray(byteSizes) || cutoffPixelsList.length !== byteSizes.length) {
    throw new Error('cutoffPixelsList and byteSizes must be parallel arrays');
  }
  const n = width * height;
  if (!n || refPixels.length !== n * 4) return { qualitySeries: [], butterSeries: [], ssimSeries: [], timing: { psnrMs: 0, butterMs: 0, ssimMs: 0, totalMs: 0 } };

  performance.mark('buildSeriesAsync-start');
  const { comparator = null, postDecodeTransform = null, psnrFn = null, ssimFn = null } = opts;
  // comparator: ButteraugliComparator (has .compare method) or null → fall back to JS createButteraugliComparer (returns callable)
  const cmp = comparator ?? createButteraugliComparer(refPixels, width, height);
  const callCmp = typeof cmp === 'function' ? cmp : (p) => cmp.compare(p);

  const qualitySeries = [], butterSeries = [], ssimSeries = [];
  const timing = { psnrMs: 0, butterMs: 0, ssimMs: 0, totalMs: 0 };

  for (let i = 0; i < cutoffPixelsList.length; i++) {
    let p = cutoffPixelsList[i];
    const b = byteSizes[i];
    if (!p || p.length !== n * 4) continue;
    if (postDecodeTransform) {
      const transformed = postDecodeTransform(p, { bytes: b, width, height, index: i, layer: i >> 1 });
      if (transformed && transformed.length === p.length) p = transformed;
    }

    let t = performance.now();
    const currentPsnr = psnrFn
      ? (await psnrFn(p, refPixels, width, height) ?? computePsnrVsFinal(p, refPixels))
      : computePsnrVsFinal(p, refPixels);
    timing.psnrMs += performance.now() - t;

    const prevPsnr = qualitySeries.length > 0 ? qualitySeries[qualitySeries.length - 1].psnr : null;
    const psnrDelta = prevPsnr != null ? Math.abs(currentPsnr - prevPsnr) : Infinity;
    const doFull = (i % 2 === 0) || (b > 100 * 1024) || psnrDelta > 0.5;
    qualitySeries.push({ bytes: b, psnr: currentPsnr });

    t = performance.now();
    butterSeries.push({ bytes: b, butter: doFull ? callCmp(p) : null });
    timing.butterMs += performance.now() - t;

    t = performance.now();
    const currentSsim = ssimFn
      ? (await ssimFn(p, refPixels, width, height) ?? computeSsimVsFinal(p, refPixels, width, height))
      : computeSsimVsFinal(p, refPixels, width, height);
    timing.ssimMs += performance.now() - t;
    ssimSeries.push({ bytes: b, ssim: currentSsim });
  }
  performance.measure('buildSeriesAsync', 'buildSeriesAsync-start');
  timing.totalMs = timing.psnrMs + timing.butterMs + timing.ssimMs;
  return { qualitySeries, butterSeries, ssimSeries, timing };
}

// Layer5 / Lens12/16/18: Pass butterSeries (or ssimSeries) computed from external model/recog score
// (e.g. plant classifier logit or embedding dist on cutoff pixels) for task-aware early term instead of
// pure fidelity. Pairs with new color constancy in Rust LookRenderer for illum-invariant AR.

// buildSeries: auto producer helper. ref + list of cutoff pixel bufs + parallel byteSizes -> ready series for summarize.
// Uses comparer for butter speed (layer1/2 cohesion win). No final needed if using self-stability or external.
export function buildSeries(refPixels, cutoffPixelsList, byteSizes, width, height, postDecodeTransform = null) {
  if (!Array.isArray(cutoffPixelsList) || !Array.isArray(byteSizes) || cutoffPixelsList.length !== byteSizes.length) {
    throw new Error('cutoffPixelsList and byteSizes must be parallel arrays');
  }
  const n = width * height;
  if (!n || refPixels.length !== n * 4) return { qualitySeries: [], butterSeries: [], ssimSeries: [], timing: { psnrMs: 0, butterMs: 0, ssimMs: 0, totalMs: 0 } };
  performance.mark('buildSeries-start');
  const cmp = createButteraugliComparer(refPixels, width, height);
  const qualitySeries = [];
  const butterSeries = [];
  const ssimSeries = [];
  // Per-metric timing accumulators — zero-overhead performance.now() pairs; visible in DevTools Timeline.
  const timing = { psnrMs: 0, butterMs: 0, ssimMs: 0, totalMs: 0 };
  for (let i = 0; i < cutoffPixelsList.length; i++) {
    let p = cutoffPixelsList[i];
    const b = byteSizes[i];
    if (!p || p.length !== n * 4) continue;
    if (postDecodeTransform) {
      // Layer 2/5: support for post layer transform (e.g. perceptual constancy) before expensive butter.
      // Allows early exit sampling + vision hooks without full cost every cutoff. More hooks for Cursor layer.
      const transformed = postDecodeTransform(p, { bytes: b, width, height, index: i, layer: i >> 1 });
      if (transformed && transformed.length === p.length) p = transformed;
    }
    // Adaptive butter skip: if PSNR delta from previous entry < 0.5 dB, perceptual score won't change significantly.
    let t = performance.now();
    const currentPsnr = computePsnrVsFinal(p, refPixels);
    timing.psnrMs += performance.now() - t;
    const prevPsnr = qualitySeries.length > 0 ? qualitySeries[qualitySeries.length - 1].psnr : null;
    const psnrDelta = prevPsnr != null ? Math.abs(currentPsnr - prevPsnr) : Infinity;
    const doFull = (i % 2 === 0) || (b > 100 * 1024) || psnrDelta > 0.5;
    qualitySeries.push({ bytes: b, psnr: currentPsnr });
    t = performance.now();
    butterSeries.push({ bytes: b, butter: doFull ? cmp(p) : null });
    timing.butterMs += performance.now() - t;
    t = performance.now();
    ssimSeries.push({ bytes: b, ssim: computeSsimVsFinal(p, refPixels, width, height) });
    timing.ssimMs += performance.now() - t;
  }
  performance.measure('buildSeries', 'buildSeries-start');
  timing.totalMs = timing.psnrMs + timing.butterMs + timing.ssimMs;
  return { qualitySeries, butterSeries, ssimSeries, timing };
}


