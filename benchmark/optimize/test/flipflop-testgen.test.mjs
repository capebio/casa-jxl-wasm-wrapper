import { test } from 'node:test';
import assert from 'node:assert/strict';
import { genTest } from '../flipflop-testgen.mjs';

test('emits async variants + quality hook for lossy photon metric', () => {
  const src = genTest({
    name: 'photon-iso-sweep',
    description: 'photonNoiseIso baseline vs candidate',
    lossless: false,
    baseline: { label: 'iso800', expr: 'encodePhoton(input, 800)' },
    candidate: { label: 'iso400', expr: 'encodePhoton(input, 400)' },
  });
  assert.match(src, /export const name = 'photon-iso-sweep'/);
  assert.match(src, /baseline: true/);
  assert.match(src, /async \(input, ctx\) =>/);          // async variant
  assert.match(src, /export function quality/);          // lossy → quality hook
  assert.doesNotMatch(src, /export function equal/);     // lossy → no pixel-exact equal
});

test('emits equal() (pixel-exact) and no quality for lossless metric', () => {
  const src = genTest({
    name: 'raw-tone-simd',
    description: 'scalar vs simd tone',
    lossless: true,
    baseline: { label: 'scalar', expr: 'decodeRawScalar(input)' },
    candidate: { label: 'simd', expr: 'decodeRawSimd(input)' },
  });
  assert.match(src, /export function equal/);
  assert.doesNotMatch(src, /export function quality/);
  assert.match(src, /role: 'primary'/);
});

test('candidate role overridable to fallback', () => {
  const src = genTest({
    name: 'x', description: 'y', lossless: true,
    baseline: { label: 'a', expr: 'f(input)' },
    candidate: { label: 'b', expr: 'g(input)', role: 'fallback' },
  });
  assert.match(src, /role: 'fallback'/);
});
