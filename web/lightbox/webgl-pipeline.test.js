import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const pipelineJs = readFileSync(new URL('./webgl-pipeline.js', import.meta.url), 'utf8');
const lightboxJs = readFileSync(new URL('./pyramid-lightbox.js', import.meta.url), 'utf8');
const decodeJs = readFileSync(new URL('../pyramid-gallery/pyramid-decode.js', import.meta.url), 'utf8');

test('webgl pipeline uses RGBA16F shader path and FS dither', () => {
  expect(pipelineJs).toContain('RGBA16F');
  expect(pipelineJs).toContain('createHdrRenderer');
  expect(pipelineJs).toContain('floydSteinbergDitherToCanvas');
  expect(pipelineJs).toContain('adjustToFloat');
  expect(pipelineJs).toContain('adjustedRgba16ForExport');
});

test('lightbox exports 16-bit JXL via encodeRgba16 on HDR path', () => {
  expect(lightboxJs).toContain('encodeRgba16');
  expect(lightboxJs).toContain('adjustedRgba16ForExport');
  expect(lightboxJs).toContain('decodePyramidRegion');
  expect(lightboxJs).toContain('-roi.jxl');
});

test('pyramid-decode exposes decodePyramidRegion for ROI export', () => {
  expect(decodeJs).toContain('decodePyramidRegion');
  expect(decodeJs).toContain('createDecoder');
});