import { expect, test } from 'bun:test';
import { APPROVED_LIGHTBOX_PRESETS, LightboxPreset } from '../../packages/jxl-pyramid/dist/constants.js';
import {
  buildColorMatrix,
  clampAdjustments,
  applyColorMatrixInPlace,
} from './filter-engine.js';

test('all 12 approved presets are supported', () => {
  expect(APPROVED_LIGHTBOX_PRESETS.length).toBe(12);
  for (const preset of APPROVED_LIGHTBOX_PRESETS) {
    expect(Object.values(LightboxPreset)).toContain(preset);
    expect(buildColorMatrix(preset).length).toBe(20);
  }
});

test('unsupported preset throws', () => {
  expect(() => buildColorMatrix('NOPE')).toThrow('unsupported preset');
});

test('adjustment params clamp to spec ranges', () => {
  const adj = clampAdjustments({ brightness: 200, highlights: -50, shadows: 10 });
  expect(adj.brightness).toBe(100);
  expect(adj.highlights).toBe(-50);
  expect(adj.shadows).toBe(10);
});

test('color matrix mutates rgba buffer', () => {
  const px = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]);
  applyColorMatrixInPlace(px, 2, 1, buildColorMatrix('BW'));
  expect(px[0]).not.toBe(255);
  expect(px[1]).toBe(px[0]);
});