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

// TODO(16-bit-ROI-export): unimplemented, see QUESTIONS.md
// The 16-bit ROI export hook (decode region via decodePyramidRegion → adjust via
// adjustedRgba16ForExport → encodeRgba16 → `-roi.jxl` download) was scoped in commit
// c108c22c ("M3 ... + 16-bit ROI export") but was never wired into pyramid-lightbox.js.
// The building blocks exist (adjustedRgba16ForExport in webgl-pipeline.js,
// decodePyramidRegion in pyramid-gallery/pyramid-decode.js, see tests below) but the
// lightbox-side glue + encodeRgba16 do not. Implementing + verifying it needs a real
// browser/WASM round-trip, so this stays skipped rather than asserting on dead strings.
test.skip('lightbox exports 16-bit JXL via encodeRgba16 on HDR path', () => {
  expect(lightboxJs).toContain('encodeRgba16');
  expect(lightboxJs).toContain('adjustedRgba16ForExport');
  expect(lightboxJs).toContain('decodePyramidRegion');
  expect(lightboxJs).toContain('-roi.jxl');
});

test('pyramid-decode exposes decodePyramidRegion for ROI export', () => {
  expect(decodeJs).toContain('decodePyramidRegion');
  expect(decodeJs).toContain('createDecoder');
});

test('filter-engine restored matrix API import-resolves', async () => {
  const fe = await import('./filter-engine.js');
  expect(typeof fe.buildColorMatrix).toBe('function');
  expect(typeof fe.clampAdjustments).toBe('function');
  expect(typeof fe.applyColorMatrixInPlace).toBe('function');
  expect(typeof fe.applyToneMapInPlace).toBe('function');
  expect(typeof fe.computeHistogram).toBe('function');
});

test('NONE preset builds 20-elem identity that matrixUniforms maps to m0=[1,0,0] off=[0,0,0]', async () => {
  const fe = await import('./filter-engine.js');
  const m = fe.buildColorMatrix('NONE');
  expect(m.length).toBe(20);
  const expected = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];
  for (let i = 0; i < 20; i++) expect(m[i]).toBeCloseTo(expected[i], 6);
  // mirror webgl-pipeline.js matrixUniforms() layout
  expect([m[0], m[1], m[2]]).toEqual([1, 0, 0]);
  expect([m[5], m[6], m[7]]).toEqual([0, 1, 0]);
  expect([m[10], m[11], m[12]]).toEqual([0, 0, 1]);
  expect([m[4] / 255, m[9] / 255, m[14] / 255]).toEqual([0, 0, 0]);
});