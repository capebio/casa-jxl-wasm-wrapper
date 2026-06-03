import { expect, test } from 'bun:test';
import { buildByteCutoffPlan, formatByteCutoffLabel } from './jxl-byte-cutoff-probe.js';

test('buildByteCutoffPlan creates unique fixed byte cutoffs plus final', () => {
  const plan = buildByteCutoffPlan(60 * 1024);

  expect(plan.map(p => p.bytes)).toEqual([
    1024,
    2048,
    5 * 1024,
    10 * 1024,
    25 * 1024,
    50 * 1024,
    60 * 1024,
  ]);
  expect(plan.at(-1).kind).toBe('final');
});

test('buildByteCutoffPlan handles tiny files without duplicate final entries', () => {
  const plan = buildByteCutoffPlan(1500);

  expect(plan.map(p => p.bytes)).toEqual([1024, 1500]);
  expect(plan.at(-1)).toEqual({
    bytes: 1500,
    kind: 'final',
    percent: 100,
  });
});

test('buildByteCutoffPlan adds percent probes for larger progressive streams', () => {
  const plan = buildByteCutoffPlan(505 * 1024);

  expect(plan.some(p => p.kind === 'percent' && p.percent >= 49 && p.percent <= 51)).toBe(true);
  expect(plan.some(p => p.kind === 'percent' && p.percent >= 89 && p.percent <= 91)).toBe(true);
  expect(plan.at(-1)).toMatchObject({ bytes: 505 * 1024, kind: 'final', percent: 100 });
});

test('formatByteCutoffLabel reports bytes and percent', () => {
  expect(formatByteCutoffLabel({ bytes: 50 * 1024, percent: 50, kind: 'fixed' })).toBe('50 KB - 50.0%');
  expect(formatByteCutoffLabel({ bytes: 60 * 1024, percent: 100, kind: 'final' })).toBe('Final - 60 KB');
});
