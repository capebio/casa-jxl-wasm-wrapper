import { test, expect } from 'vitest';
import { detectFormat } from './format-detect.js';

const bytes = (...b) => new Uint8Array(b);

test('magic bytes classify', () => {
  expect(detectFormat(bytes(0x76, 0x2f, 0x31, 0x01), 'x.exr')).toBe('exr');
  expect(detectFormat(bytes(0x49, 0x49, 0x2a, 0x00), 'x.tif')).toBe('tiff');
  expect(detectFormat(bytes(0x89, 0x50, 0x4e, 0x47), 'x.png')).toBe('sdr');
  expect(detectFormat(bytes(0xff, 0xd8, 0xff, 0xe0), 'x.jpg')).toBe('sdr');
  expect(detectFormat(bytes(0x47, 0x49, 0x46, 0x38), 'x.gif')).toBe('sdr');
});

test('RAW tiff containers disambiguate by extension', () => {
  // ORF/DNG/CR2 are TIFF-magic but route to RAW, not the tiff decoder
  expect(detectFormat(bytes(0x49, 0x49, 0x2a, 0x00), 'photo.orf')).toBe('raw');
  expect(detectFormat(bytes(0x49, 0x49, 0x2a, 0x00), 'photo.dng')).toBe('raw');
});

test('avif by ftyp brand', () => {
  const avif = bytes(0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66);
  expect(detectFormat(avif, 'x.avif')).toBe('sdr');
});

test('webp fourCC matches full WEBP, not partial WE', () => {
  // RIFF....WEBP -> sdr
  const webp = bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50);
  expect(detectFormat(webp, 'x.webp')).toBe('sdr');
  // RIFF....WE.. (e.g. a non-WebP RIFF whose byte9 is 'E') must NOT classify as sdr
  const notWebp = bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x00, 0x00);
  expect(detectFormat(notWebp, 'x.bin')).toBe('unknown');
});

test('unknown', () => {
  expect(detectFormat(bytes(1, 2, 3, 4), 'x.bin')).toBe('unknown');
});

// Routing contract consumed by web/worker.js: EXR/TIFF take the image-format
// decode path (decode_exr/decode_tiff → LookRenderer live-edit), RAW keeps the
// ORF/CR2/DNG pipeline, and sdr/jxl/unknown are rejected rather than misrouted
// to the Olympus decoder. These are the exact branch strings worker.js switches
// on, so they must stay stable.
test('worker routing: EXR/TIFF go to the image-format pipeline path', () => {
  // EXR by magic bytes alone (no name needed).
  expect(detectFormat(bytes(0x76, 0x2f, 0x31, 0x01), '')).toBe('exr');
  // Developed TIFF (no RAW extension) → tiff, not raw.
  expect(detectFormat(bytes(0x49, 0x49, 0x2a, 0x00), 'render.tif')).toBe('tiff');
  expect(detectFormat(bytes(0x4d, 0x4d, 0x00, 0x2a), 'render.tiff')).toBe('tiff');
  // Big-endian TIFF magic with no name still classifies as tiff.
  expect(detectFormat(bytes(0x4d, 0x4d, 0x00, 0x2a), '')).toBe('tiff');
});

test('worker routing: RAW still wins over the new TIFF path', () => {
  // TIFF-magic RAW must remain raw so it hits pickRawDecoderWithFlags.
  expect(detectFormat(bytes(0x49, 0x49, 0x2a, 0x00), 'photo.orf')).toBe('raw');
  expect(detectFormat(bytes(0x49, 0x49, 0x2a, 0x00), 'photo.cr2')).toBe('raw');
  expect(detectFormat(bytes(0x49, 0x49, 0x2a, 0x00), 'photo.dng')).toBe('raw');
});

test('worker routing: sdr/jxl/unknown are rejected, never sent to RAW decoder', () => {
  expect(detectFormat(bytes(0xff, 0xd8, 0xff, 0xe0), 'x.jpg')).toBe('sdr');
  expect(detectFormat(bytes(0xff, 0x0a), 'x.jxl')).toBe('jxl');
  expect(detectFormat(bytes(0, 0, 0, 0), 'x.weird')).toBe('unknown');
});
