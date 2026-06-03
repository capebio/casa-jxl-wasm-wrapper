import { expect, test } from 'bun:test';
import { computePsnrVsFinal, computeSsimVsFinal, detectMonotone } from './jxl-progressive-quality.js';

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
