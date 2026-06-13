import { expect, test } from 'bun:test';
import { computePsnrVsFinal, computeSsimVsFinal, detectMonotone, MONOTONE_TOLERANCE_DB } from './jxl-progressive-quality.js';
import { pixelsToXyb, computeButteraugliVsFinal, createButteraugliComparer, computeButteraugliApproxVsFinal } from './jxl-butteraugli.js';

test('PSNR of identical buffers is +Infinity', () => {
  const a = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const b = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  expect(computePsnrVsFinal(a, b)).toBe(Infinity);
});

test('PSNR of all-zero vs all-max is finite and near 0 dB', () => {
  const a = new Uint8Array([0, 0, 0, 0]);
  const b = new Uint8Array([255, 255, 255, 255]);
  const psnr = computePsnrVsFinal(a, b);
  expect(Number.isFinite(psnr)).toBe(true);
  expect(psnr).toBeLessThan(1);
});

test('PSNR rejects mismatched lengths with error', () => {
  expect(() => computePsnrVsFinal(new Uint8Array(4), new Uint8Array(8))).toThrow();
});

test('SSIM of identical buffers is 1', () => {
  const w = 4, h = 4;
  const a = new Uint8Array(w * h * 4).fill(128);
  const b = new Uint8Array(w * h * 4).fill(128);
  expect(computeSsimVsFinal(a, b, w, h)).toBe(1);
});

test('SSIM of constant 0 vs constant 255 is less than 0.5', () => {
  const w = 4, h = 4;
  const a = new Uint8Array(w * h * 4).fill(0);
  const b = new Uint8Array(w * h * 4).fill(255);
  const ssim = computeSsimVsFinal(a, b, w, h);
  expect(ssim).toBeLessThan(0.5);
});

test('SSIM accepts 3ch rgb packed', () => {
  const w = 4, h = 4;
  const a = new Uint8Array(w * h * 3).fill(128);
  const b = new Uint8Array(w * h * 3).fill(128);
  expect(computeSsimVsFinal(a, b, w, h)).toBe(1);
});

test('monotone series returns { monotone: true, regressions: [] }', () => {
  const series = [
    { bytes: 1000, psnr: 15 },
    { bytes: 5000, psnr: 22 },
    { bytes: 20000, psnr: 30 },
    { bytes: 50000, psnr: 38 },
  ];
  const result = detectMonotone(series);
  expect(result.monotone).toBe(true);
  expect(result.regressions).toEqual([]);
});

test('series with 1 dB regression is flagged', () => {
  const series = [
    { bytes: 1000, psnr: 22 },
    { bytes: 5000, psnr: 30 },
    { bytes: 20000, psnr: 28.5 },
    { bytes: 50000, psnr: 38 },
  ];
  const result = detectMonotone(series);
  expect(result.monotone).toBe(false);
  expect(result.regressions.length).toBe(1);
  expect(result.regressions[0].bytes).toBe(20000);
  expect(result.regressions[0].dropDb).toBeGreaterThan(0.5);
});

test('0.4 dB regression is within tolerance', () => {
  const series = [
    { bytes: 1000, psnr: 30 },
    { bytes: 5000, psnr: 29.6 },
    { bytes: 20000, psnr: 35 },
  ];
  const result = detectMonotone(series);
  expect(result.monotone).toBe(true);
  expect(result.regressions.length).toBe(0);
});

test('detectMonotone supports lowerIsBetter for butter-like series', () => {
  const series = [
    { bytes: 1000, butter: 2.1 },
    { bytes: 5000, butter: 0.9 },
    { bytes: 20000, butter: 0.4 },
  ];
  const result = detectMonotone(series, 0.1, { valueKey: 'butter', lowerIsBetter: true });
  expect(result.monotone).toBe(true);
  const bad = detectMonotone([
    { bytes: 1000, butter: 0.4 },
    { bytes: 5000, butter: 0.9 },
  ], 0.1, { valueKey: 'butter', lowerIsBetter: true });
  expect(bad.monotone).toBe(false);
});

test('butter identical yields 0', () => {
  const p = new Uint8Array(16).fill(128); // 2x2 rgba
  const xyb = pixelsToXyb(p, 4);
  expect(computeButteraugliVsFinal(xyb, p, 2, 2)).toBe(0);
});

test('butter comparer reuses and matches direct', () => {
  const p = new Uint8Array(64).fill(100);
  const cmp = createButteraugliComparer(p, 4, 4);
  const direct = computeButteraugliVsFinal(pixelsToXyb(p, 16), p, 4, 4);
  expect(cmp(p)).toBeCloseTo(direct, 10);
});

test('butter approx defined and non-nan', () => {
  const p = new Uint8Array(16).fill(80);
  const x = pixelsToXyb(p, 4);
  const sc = computeButteraugliApproxVsFinal(x, p, 2, 2);
  expect(Number.isFinite(sc)).toBe(true);
});

test('psnr/ssim handle 0-len gracefully', () => {
  const z = new Uint8Array(0);
  expect(computePsnrVsFinal(z, z)).toBe(Infinity);
  // ssim on 0 is edge (np=0); callers avoid, but no crash on len check
  expect(() => computeSsimVsFinal(z, z, 0, 0)).not.toThrow();
});
