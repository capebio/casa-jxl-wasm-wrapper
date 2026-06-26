import { expect, test } from 'bun:test';
import { capBytesForDisplay } from './jxl-progressive-gallery-tier-cap.js';

const manifest = {
  version: 1,
  source: { width: 4000, height: 3000, hasAlpha: false, orientation: 1 },
  jxl: { bytes: 100000, sha256: 'a'.repeat(64) },
  encoder: { name: 't', libjxlVersion: '0.12', flags: [] },
  tiers: [
    { name: 'dc', byteStart: 0, byteEnd: 8000, progressionIndex: 0, intendedUse: 'thumbnail' },
    { name: 'preview', byteStart: 0, byteEnd: 40000, progressionIndex: 2, intendedUse: 'visible-card' },
    { name: 'full', byteStart: 0, byteEnd: 100000, progressionIndex: 'final', intendedUse: 'zoom-export' },
  ],
  scaleFrontier: [
    { maxDisplayPx: 256, tier: 'dc', byteEnd: 8000, score: { metric: 'psnr', value: 36, reference: 'final' } },
    { maxDisplayPx: 1024, tier: 'preview', byteEnd: 40000, score: { metric: 'psnr', value: 34, reference: 'final' } },
    { maxDisplayPx: 99999, tier: 'full', byteEnd: 100000, score: { metric: 'psnr', value: 99, reference: 'final' } },
  ],
};

test('returns full byteLength when no manifest', () => {
  expect(capBytesForDisplay(null, 100, 100, 1, 100000)).toBe(100000);
});

test('caps to dc tier for a tiny thumbnail', () => {
  expect(capBytesForDisplay(manifest, 120, 80, 1, 100000)).toBe(8000);
});

test('caps to preview tier for a card-sized element (DPR aware)', () => {
  // 180px element at DPR 2 → 360px longest edge → preview, not dc
  expect(capBytesForDisplay(manifest, 180, 120, 2, 100000)).toBe(40000);
});

test('never exceeds the actual buffer length', () => {
  expect(capBytesForDisplay(manifest, 5000, 5000, 2, 50000)).toBe(50000);
});
