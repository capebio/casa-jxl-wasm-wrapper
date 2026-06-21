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

test('unknown', () => {
  expect(detectFormat(bytes(1, 2, 3, 4), 'x.bin')).toBe('unknown');
});
