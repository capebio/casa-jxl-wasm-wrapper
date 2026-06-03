import { expect, test } from 'bun:test';
import {
  createProgressiveWebPreset,
  createSidecarTargetPlan,
  createSneyersPreset,
  resolveQualityPolicy,
  resolveTargetDimensions,
  SNEYERS_PRESET,
} from './jxl-progressive-best-preset.js';

test('createProgressiveWebPreset returns cjxl-style early preview encoder settings', () => {
  const preset = createProgressiveWebPreset({ width: 4000, height: 3000, targetLongEdge: 800, quality: 87 });

  expect(preset.target).toEqual({ width: 800, height: 600, longEdge: 800, scale: 0.2 });
  expect(preset.encode).toMatchObject({
    format: 'rgba8',
    width: 800,
    height: 600,
    hasAlpha: true,
    quality: 87,
    effort: 3,
    progressive: true,
    progressiveFlavor: 'ac',
    previewFirst: true,
    progressiveDc: 2,
    groupOrder: 1,
  });
  expect(preset.decode).toMatchObject({
    format: 'rgba8',
    progressionTarget: 'final',
    emitEveryPass: true,
    progressiveDetail: 'passes',
  });
});

test('resolveTargetDimensions avoids upscaling and preserves aspect ratio', () => {
  expect(resolveTargetDimensions(1024, 512, 300)).toEqual({ width: 300, height: 150, longEdge: 300, scale: 300 / 1024 });
  expect(resolveTargetDimensions(300, 200, 800)).toEqual({ width: 300, height: 200, longEdge: 300, scale: 1 });
  expect(resolveTargetDimensions(300, 200, 'full')).toEqual({ width: 300, height: 200, longEdge: 300, scale: 1 });
});

test('resolveQualityPolicy reports SSIMULACRA2 target as unavailable instead of pretending to optimize', () => {
  const policy = resolveQualityPolicy({ quality: 85, ssimulacra2Target: 80 });

  expect(policy.quality).toBe(85);
  expect(policy.mode).toBe('fixed-quality');
  expect(policy.ssimulacra2.requested).toBe(true);
  expect(policy.ssimulacra2.available).toBe(false);
  expect(policy.ssimulacra2.message).toContain('SSIMULACRA2');
});

test('SNEYERS_PRESET is frozen and contains expected Sneyers flags', () => {
  expect(Object.isFrozen(SNEYERS_PRESET)).toBe(true);
  expect(SNEYERS_PRESET.progressive).toBe(true);
  expect(SNEYERS_PRESET.previewFirst).toBe(true);
  expect(SNEYERS_PRESET.progressiveDc).toBe(2);
  expect(SNEYERS_PRESET.progressiveAc).toBe(1);
  expect(SNEYERS_PRESET.qProgressiveAc).toBe(1);
  expect(SNEYERS_PRESET.groupOrder).toBe(1);
  expect(SNEYERS_PRESET.effort).toBe(3);
  expect(SNEYERS_PRESET.decodingSpeed).toBe(0);
});

test('createSneyersPreset returns target/encode/decode triple', () => {
  const preset = createSneyersPreset({ width: 4000, height: 3000, targetLongEdge: 1200, quality: 80 });
  expect(preset.target.width).toBe(1200);
  expect(preset.target.height).toBe(900);
  expect(preset.encode.progressiveDc).toBe(2);
  expect(preset.encode.qProgressiveAc).toBe(1);
  expect(preset.encode.effort).toBe(3);
  expect(preset.encode.quality).toBe(80);
  expect(preset.decode.emitEveryPass).toBe(true);
  expect(preset.decode.progressiveDetail).toBe('passes');
});

test('createSneyersPreset honours progressiveDetail override', () => {
  const preset = createSneyersPreset({ width: 100, height: 100, progressiveDetail: 'dc' });
  expect(preset.decode.progressiveDetail).toBe('dc');
});

test('createSidecarTargetPlan sends a 300px thumbnail before larger target output', () => {
  expect(createSidecarTargetPlan(1600)).toEqual([300, 1600]);
  expect(createSidecarTargetPlan(800)).toEqual([300, 800]);
  expect(createSidecarTargetPlan(300)).toEqual([300]);
  expect(createSidecarTargetPlan('full')).toEqual([300, 'full']);
});
