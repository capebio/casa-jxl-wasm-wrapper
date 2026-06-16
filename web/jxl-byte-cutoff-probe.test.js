import { expect, test } from 'bun:test';
import {
  buildByteCutoffPlan,
  formatByteCutoffLabel,
  TRANSPORT_PROFILES,
} from './jxl-byte-cutoff-probe.js';

test('buildByteCutoffPlan returns empty for invalid totals', () => {
  expect(buildByteCutoffPlan(0)).toEqual([]);
  expect(buildByteCutoffPlan(-1)).toEqual([]);
  expect(buildByteCutoffPlan(Number.NaN)).toEqual([]);
});

test('buildByteCutoffPlan keeps tiny stream minimal and final only when needed', () => {
  expect(buildByteCutoffPlan(512)).toEqual([
    {
      bytes: 512,
      kind: 'final',
      percent: 100,
      coverageHint: 'complete',
      stageHint: 'final',
    },
  ]);
});

test('buildByteCutoffPlan builds unique monotonic cutoffs with stage hints', () => {
  const plan = buildByteCutoffPlan(60 * 1024);

  expect(plan.map((entry) => entry.bytes)).toEqual([
    1024,
    2048,
    5120,
    10240,
    20480,
    40960,
    61440,
  ]);
  expect(plan.every((entry, index) => index === 0 || entry.bytes > plan[index - 1].bytes)).toBe(true);
  expect(plan.at(-1)).toEqual({
    bytes: 60 * 1024,
    kind: 'final',
    percent: 100,
    coverageHint: 'complete',
    stageHint: 'final',
  });
  expect(plan[0]).toMatchObject({ kind: 'fixed', coverageHint: 'tiny-preview', stageHint: 'first-signal' });
  expect(plan.some((entry) => entry.stageHint === 'shape-stable')).toBe(true);
  expect(plan.some((entry) => entry.stageHint === 'texture-usable')).toBe(true);
});

test('buildByteCutoffPlan avoids duplicate byte checkpoints from collisions', () => {
  const plan = buildByteCutoffPlan(200 * 1024, {
    fixedCutoffs: [1024, 2048, 2048, 10 * 1024],
    percentCutoffs: [0.5, 1, 1, 5, 100, -1],
  });

  const bytes = plan.map((entry) => entry.bytes);
  expect(new Set(bytes).size).toBe(bytes.length);
  expect(plan.filter((entry) => entry.bytes === 2048)).toHaveLength(1);
});

test('buildByteCutoffPlan keeps early region denser than tail for transport profiles', () => {
  for (const profileName of ['3g', 'lte', 'wifi', 'diagnostic']) {
    const plan = buildByteCutoffPlan(2 * 1024 * 1024, {
      transportProfile: profileName,
      maxSteps: 12,
    });
    const bytes = plan.map((entry) => entry.bytes);
    const early = bytes.filter((value) => value <= 128 * 1024);
    const tail = bytes.filter((value) => value > 128 * 1024 && value < 2 * 1024 * 1024);
    expect(plan.at(-1)).toMatchObject({ bytes: 2 * 1024 * 1024, kind: 'final' });
    expect(plan.length).toBeLessThanOrEqual(13);
    expect(early.length).toBeGreaterThanOrEqual(tail.length);
  }
});

test('buildByteCutoffPlan supports explicit transport profile objects', () => {
  const plan = buildByteCutoffPlan(512 * 1024, {
    transportProfile: { chunkBytes: 4096, chunkDelayMs: 80, jitterMs: 20 },
    maxSteps: 10,
  });

  expect(plan.length).toBeLessThanOrEqual(11);
  expect(plan[0].bytes).toBe(1024);
  expect(plan.at(-1)).toMatchObject({ bytes: 512 * 1024, kind: 'final' });
});

test('buildByteCutoffPlan preserves bounded percent values and no non-final equals total', () => {
  for (const total of [1500, 10 * 1024, 64 * 1024, 250 * 1024, 5 * 1024 * 1024]) {
    const plan = buildByteCutoffPlan(total);
    for (const entry of plan.slice(0, -1)) {
      expect(entry.bytes).toBeLessThan(total);
      expect(entry.percent).toBeGreaterThan(0);
      expect(entry.percent).toBeLessThan(100);
    }
    expect(plan.at(-1)).toMatchObject({ bytes: total, percent: 100, kind: 'final' });
  }
});

test('formatByteCutoffLabel reports B, KB, MB, and final labels', () => {
  expect(formatByteCutoffLabel({ bytes: 512, percent: 25, kind: 'fixed' })).toBe('512 B - 25.0%');
  expect(formatByteCutoffLabel({ bytes: 1536, percent: 50, kind: 'fixed' })).toBe('1.5 KB - 50.0%');
  expect(formatByteCutoffLabel({ bytes: 2.5 * 1024 * 1024, percent: 80, kind: 'percent' })).toBe('2.5 MB - 80.0%');
  expect(formatByteCutoffLabel({ bytes: 60 * 1024, percent: 100, kind: 'final' })).toBe('Final - 60 KB');
});

test('transport profiles expose expected named presets', () => {
  expect(Object.keys(TRANSPORT_PROFILES).sort()).toEqual(['3g', 'diagnostic', 'lte', 'wifi']);
  expect(TRANSPORT_PROFILES.diagnostic.chunkBytes).toBeLessThan(TRANSPORT_PROFILES.wifi.chunkBytes);
});
