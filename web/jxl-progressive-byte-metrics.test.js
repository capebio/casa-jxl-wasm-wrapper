import { expect, test } from 'bun:test';
import {
  classifyByteCutoffFrame,
  summarizeByteCutoffResults,
} from './jxl-progressive-byte-metrics.js';

test('summarizeByteCutoffResults reports first paint, preview, final and counts', () => {
  const summary = summarizeByteCutoffResults([
    { bytes: 1024, painted: false, isFinal: false, frameCount: 0 },
    { bytes: 10_240, painted: true, isFinal: false, frameCount: 1 },
    { bytes: 50_000, painted: true, isFinal: false, frameCount: 2 },
    { bytes: 80_000, painted: true, isFinal: true, frameCount: 3 },
  ], 80_000);

  expect(summary).toEqual({
    totalBytes: 80_000,
    firstPaintBytes: 10_240,
    firstPaintPercent: 12.8,
    firstRecognizableBytes: null,
    firstRecognizablePercent: null,
    previewBytes: 50_000,
    previewPercent: 62.5,
    finalBytes: 80_000,
    finalPercent: 100,
    finalPsnr: null,
    paintedCutoffs: 3,
    maxFrameCount: 3,
    usefulEarlyPaint: true,
    monotone: null,
    regressions: [],
  });
});

test('summarizeByteCutoffResults handles no prefix paint honestly', () => {
  const summary = summarizeByteCutoffResults([
    { bytes: 1024, painted: false, isFinal: false, frameCount: 0 },
    { bytes: 2048, painted: false, isFinal: false, frameCount: 0 },
  ], 2048);

  expect(summary.firstPaintBytes).toBeNull();
  expect(summary.previewBytes).toBeNull();
  expect(summary.usefulEarlyPaint).toBe(false);
});

test('classifyByteCutoffFrame captures painted/final state from decoder event list', () => {
  expect(classifyByteCutoffFrame({ bytes: 50_000, events: [] })).toMatchObject({
    bytes: 50_000,
    painted: false,
    frameCount: 0,
    isFinal: false,
  });
  expect(classifyByteCutoffFrame({
    bytes: 50_000,
    events: [{ type: 'progress' }, { type: 'final' }],
  })).toMatchObject({
    bytes: 50_000,
    painted: true,
    frameCount: 2,
    isFinal: true,
  });
});

test('summarizeByteCutoffResults exposes quality fields when qualitySeries supplied', () => {
  const results = [
    { bytes: 1000, painted: false, frameCount: 0, isFinal: false },
    { bytes: 5000, painted: true, frameCount: 1, isFinal: false, stage: 'dc' },
    { bytes: 20000, painted: true, frameCount: 2, isFinal: false, stage: 'pass' },
    { bytes: 50000, painted: true, frameCount: 3, isFinal: true, stage: 'final' },
  ];
  const qualitySeries = [
    { bytes: 5000, psnr: 18 },
    { bytes: 20000, psnr: 28 },
    { bytes: 50000, psnr: 42 },
  ];
  const summary = summarizeByteCutoffResults(results, 50000, { qualitySeries });
  expect(summary.firstRecognizableBytes).toBe(20000);
  expect(summary.previewBytes).toBe(50000);
  expect(summary.finalPsnr).toBe(42);
  expect(summary.monotone).toBe(true);
  expect(summary.regressions).toEqual([]);
});

test('summarizeByteCutoffResults without qualitySeries keeps backwards-compatible shape', () => {
  const results = [
    { bytes: 1000, painted: true, frameCount: 1, isFinal: false, stage: 'dc' },
    { bytes: 5000, painted: true, frameCount: 1, isFinal: true, stage: 'final' },
  ];
  const summary = summarizeByteCutoffResults(results, 5000);
  expect(summary.firstPaintBytes).toBe(1000);
  expect(summary.firstRecognizableBytes).toBeNull();
  expect(summary.finalPsnr).toBeNull();
  expect(summary.monotone).toBeNull();
});
