import { expect, test } from 'bun:test';
import { buildPushBatches } from './jxl-progressive-gallery-push.js';
import * as Best from './jxl-progressive-best-preset.js';

function batchLengths(batches) {
  return batches.map(batch => batch.map(chunk => chunk.byteLength));
}

test('buildPushBatches pushes the full file in one batch when requested', () => {
  const buffer = new Uint8Array(10).buffer;

  const batches = buildPushBatches(buffer, {
    mode: 'full-file',
    chunkSize: 4,
    windowSize: 2,
  });

  expect(batchLengths(batches)).toEqual([[10]]);
});

test('buildPushBatches keeps each chunk separate in all-chunks mode', () => {
  const buffer = new Uint8Array(10).buffer;

  const batches = buildPushBatches(buffer, {
    mode: 'all-chunks',
    chunkSize: 4,
    windowSize: 2,
  });

  expect(batchLengths(batches)).toEqual([[4], [4], [2]]);
});

test('buildPushBatches groups chunks into windows in window mode', () => {
  const buffer = new Uint8Array(10).buffer;

  const batches = buildPushBatches(buffer, {
    mode: 'window',
    chunkSize: 3,
    windowSize: 2,
  });

  expect(batchLengths(batches)).toEqual([[3, 3], [3, 1]]);
});

test('buildPushBatches handles empty, single-byte and exact-multiple cases', () => {
  expect(buildPushBatches(new Uint8Array(0).buffer, { chunkSize: 4 })).toEqual([]);
  const one = buildPushBatches(new Uint8Array(1).buffer, { mode: 'all-chunks', chunkSize: 4 });
  expect(batchLengths(one)).toEqual([[1]]);
  const exact = buildPushBatches(new Uint8Array(8).buffer, { mode: 'window', chunkSize: 4, windowSize: 2 });
  expect(batchLengths(exact)).toEqual([[4, 4]]);
});

test('buildPushBatches returns zero-copy Uint8Array subarray views', () => {
  const src = new Uint8Array(10);
  const batches = buildPushBatches(src.buffer, { mode: 'all-chunks', chunkSize: 3 });
  const view = batches[0][0];
  expect(view).toBeInstanceOf(Uint8Array);
  expect(view.byteLength).toBe(3);
  // view shares backing (no copy)
  src[0] = 42;
  expect(view[0]).toBe(42);
});

test('buildPushBatches can use cutoff-derived sizes for multi-asset delivery', () => {
  const cut = Best.PROGRESSIVE_WEB_BYTE_CUTOFFS;
  const size = cut[6] + 10000; // ~110k
  const buf = new Uint8Array(size).buffer;
  const batches = buildPushBatches(buf, { mode: 'window', chunkSize: Best.DEFAULT_CHUNK_SIZE || 65536, windowSize: Best.DEFAULT_WINDOW_SIZE || 32 });
  expect(batches.length).toBeGreaterThan(0);
  expect(batches[0].every(c => c.byteLength <= 65536)).toBe(true);
});

test('buildPushBatches byteCutoffs param (pass 2 direct) – adaptive lives in caller getPushBatchingOptions; fn accepts but does not mutate chunk inside', () => {
  const buf = new Uint8Array(300 * 1024).buffer;
  const batches = buildPushBatches(buf, {
    mode: 'window',
    chunkSize: 65536,
    windowSize: 32,
    byteCutoffs: Best.PROGRESSIVE_WEB_BYTE_CUTOFFS,
  });
  // still produces reasonable windows; no internal size-based chunk resize (by design, after reassess)
  expect(batches[0].length).toBeGreaterThan(0);
  expect(batches[0][0].byteLength).toBe(65536);
});
