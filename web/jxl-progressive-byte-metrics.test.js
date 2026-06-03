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
    previewBytes: 50_000,
    previewPercent: 62.5,
    finalBytes: 80_000,
    finalPercent: 100,
    paintedCutoffs: 3,
    maxFrameCount: 3,
    usefulEarlyPaint: true,
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

