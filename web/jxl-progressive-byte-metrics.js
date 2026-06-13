import { detectMonotone } from './jxl-progressive-quality.js';

export const RECOGNIZABLE_DB = 20;
export const PREVIEW_DB = 30;

export function classifyByteCutoffFrame({ bytes, events = [], error = null }) {
  const frames = events.filter((event) => event && (event.type === 'progress' || event.type === 'final'));
  return {
    bytes,
    painted: frames.length > 0,
    frameCount: frames.length,
    isFinal: frames.some((event) => event.type === 'final'),
    stage: frames.at(-1)?.stage ?? (frames.at(-1)?.type ?? null),
    error,
  };
}

export function summarizeByteCutoffResults(results, totalBytes, { qualitySeries = null, butterSeries = null, ssimSeries = null, goodButter = 1.0 } = {}) {
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
    const m = detectMonotone(ss.map((e) => ({ bytes: e.bytes, butter: e.butter })), 0.1, { valueKey: 'butter', lowerIsBetter: true });
    butterMonotone = m.monotone;
    butterRegressions = m.regressions;
  }

  // ssimSeries support for symmetry (higher-better like psnr); fields added if present
  let firstGoodSsimBytes = null, finalSsim = null, ssimMonotone = null, ssimRegressions = [];
  if (Array.isArray(ssimSeries) && ssimSeries.length > 0) {
    const ss = ensureSorted(ssimSeries);
    firstGoodSsimBytes = ss.find((e) => e.ssim != null && e.ssim >= 0.8)?.bytes ?? null;
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
  return Number(((bytes / totalBytes) * 100).toFixed(1));
}

// Layer5 / Lens12/16/18: Pass butterSeries (or ssimSeries) computed from external model/recog score
// (e.g. plant classifier logit or embedding dist on cutoff pixels) for task-aware early term instead of
// pure fidelity. Pairs with new color constancy in Rust LookRenderer for illum-invariant AR.

