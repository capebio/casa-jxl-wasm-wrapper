import { expect, test } from 'bun:test';
import { packFramePixels } from './jxl-progressive-gallery-frame.js';

test('packFramePixels removes row padding from strided rgba8 frames', () => {
  const frame = {
    info: { width: 2, height: 2 },
    pixelStride: 12,
    pixels: new Uint8Array([
      1, 2, 3, 4,
      5, 6, 7, 8,
      250, 251, 252, 253,
      9, 10, 11, 12,
      13, 14, 15, 16,
      254, 253, 252, 251,
    ]).buffer,
  };

  expect(Array.from(packFramePixels(frame))).toEqual([
    1, 2, 3, 4,
    5, 6, 7, 8,
    9, 10, 11, 12,
    13, 14, 15, 16,
  ]);
});
