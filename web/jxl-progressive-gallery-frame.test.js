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

// Regression (P2200708-prog-p6-q85.jxl diagonal banding): the decoder reports pixelStride as
// bytes-PER-PIXEL (4 for rgba8), which is < a full row. It must be treated as a tight buffer,
// NOT a 4-byte row stride (which sheared every row).
test('packFramePixels treats bytes-per-pixel pixelStride (4) as a tight rgba8 buffer', () => {
  const frame = {
    info: { width: 3, height: 2 },
    pixelStride: 4, // bytes per pixel, NOT a row stride
    pixels: new Uint8Array([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,        // row 0 (3 px)
      13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, // row 1 (3 px)
    ]).buffer,
  };
  expect(Array.from(packFramePixels(frame))).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
  ]);
});
