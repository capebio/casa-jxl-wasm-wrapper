import { expect, test } from 'bun:test';
import { createGalleryCoordinator } from './jxl-progressive-gallery-coordinator.js';

test('releases roughest frames across all files before later rounds', () => {
  const coordinator = createGalleryCoordinator({
    files: [
      { fileId: 'a', name: 'a.jxl', byteLength: 100 },
      { fileId: 'b', name: 'b.jxl', byteLength: 200 },
    ],
  });

  coordinator.registerFrame('a', {
    frameIndex: 0,
    stage: 'dc',
    elapsedMs: 10,
    bytesFed: 64,
    info: { width: 1, height: 1 },
  });
  coordinator.registerFrame('a', {
    frameIndex: 1,
    stage: 'pass',
    elapsedMs: 20,
    bytesFed: 128,
    info: { width: 1, height: 1 },
  });

  expect(coordinator.visibleFrames('a').map((f) => f.frameIndex)).toEqual([0]);
  expect(coordinator.visibleFrames('b')).toEqual([]);

  coordinator.registerFrame('b', {
    frameIndex: 0,
    stage: 'dc',
    elapsedMs: 12,
    bytesFed: 80,
    info: { width: 2, height: 2 },
  });

  expect(coordinator.visibleFrames('a').map((f) => f.frameIndex)).toEqual([0]);
  expect(coordinator.visibleFrames('b').map((f) => f.frameIndex)).toEqual([0]);

  coordinator.markFileClosed('b');
  expect(coordinator.visibleFrames('a').map((f) => f.frameIndex)).toEqual([0, 1]);
});

test('wraps within a file series for exact-frame navigation', () => {
  const coordinator = createGalleryCoordinator({
    files: [{ fileId: 'a', name: 'a.jxl', byteLength: 100 }],
  });

  coordinator.registerFrame('a', { frameIndex: 0, stage: 'dc', elapsedMs: 10, bytesFed: 10, info: { width: 1, height: 1 } });
  coordinator.registerFrame('a', { frameIndex: 1, stage: 'pass', elapsedMs: 20, bytesFed: 20, info: { width: 1, height: 1 } });
  coordinator.registerFrame('a', { frameIndex: 2, stage: 'final', elapsedMs: 30, bytesFed: 100, info: { width: 1, height: 1 } });

  expect(coordinator.nextFrameIndex('a', 2)).toBe(0);
  expect(coordinator.prevFrameIndex('a', 0)).toBe(2);
});
