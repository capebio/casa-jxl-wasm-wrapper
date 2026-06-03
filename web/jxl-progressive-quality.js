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

const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;

export function computeSsimVsFinal(cutoffPixels, finalPixels, width, height) {
  if (cutoffPixels.length !== finalPixels.length) {
    throw new Error(`SSIM length mismatch: ${cutoffPixels.length} vs ${finalPixels.length}`);
  }
  const channels = cutoffPixels.length / (width * height);
  if (!Number.isInteger(channels)) {
    throw new Error(`SSIM pixel count not divisible by ${width}*${height}`);
  }
  let sumSsim = 0;
  let windowCount = 0;
  const windowChannels = Math.min(channels, 3);
  for (let c = 0; c < windowChannels; c++) {
    let muA = 0, muB = 0;
    for (let i = 0; i < width * height; i++) {
      muA += cutoffPixels[i * channels + c];
      muB += finalPixels[i * channels + c];
    }
    muA /= width * height;
    muB /= width * height;
    let varA = 0, varB = 0, cov = 0;
    for (let i = 0; i < width * height; i++) {
      const a = cutoffPixels[i * channels + c] - muA;
      const b = finalPixels[i * channels + c] - muB;
      varA += a * a;
      varB += b * b;
      cov += a * b;
    }
    varA /= width * height;
    varB /= width * height;
    cov /= width * height;
    const num = (2 * muA * muB + C1) * (2 * cov + C2);
    const den = (muA * muA + muB * muB + C1) * (varA + varB + C2);
    sumSsim += num / den;
    windowCount++;
  }
  return windowCount === 0 ? 0 : sumSsim / windowCount;
}

const MONOTONE_TOLERANCE_DB = 0.5;

export function detectMonotone(series, toleranceDb = MONOTONE_TOLERANCE_DB) {
  const regressions = [];
  let prev = -Infinity;
  for (const entry of series) {
    if (!Number.isFinite(entry.psnr)) continue;
    if (prev !== -Infinity && entry.psnr < prev - toleranceDb) {
      regressions.push({ bytes: entry.bytes, dropDb: Number((prev - entry.psnr).toFixed(2)) });
    }
    if (entry.psnr > prev) prev = entry.psnr;
  }
  return { monotone: regressions.length === 0, regressions };
}
