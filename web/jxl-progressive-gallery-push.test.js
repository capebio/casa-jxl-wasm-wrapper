import { expect, test } from 'bun:test';
import { buildPushBatches } from './jxl-progressive-gallery-push.js';

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
