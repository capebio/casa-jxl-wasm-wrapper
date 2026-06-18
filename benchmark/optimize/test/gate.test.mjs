import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../gate.mjs';

const base = { lossless: false, butteraugli_delta: 0.4, pixel_exact: false, saved_pct: 12, rss_delta_mb: 0, removes_dup: false, role: 'primary' };

test('lossy faster within butteraugli threshold → accepted/faster', () => {
  const v = evaluate(base, { butteraugliThreshold: 1.0, slowdownEpsilon: 3 });
  assert.equal(v.accepted, true);
  assert.equal(v.accept_reason, 'faster');
});

test('lossy quality regression → rejected even if faster', () => {
  const v = evaluate({ ...base, butteraugli_delta: 1.6, saved_pct: 40 }, { butteraugliThreshold: 1.0, slowdownEpsilon: 3 });
  assert.equal(v.accepted, false);
  assert.match(v.reason, /butteraugli/i);
});

test('lossless must be pixel_exact', () => {
  const v = evaluate({ ...base, lossless: true, pixel_exact: false, saved_pct: 50 }, { butteraugliThreshold: 1.0, slowdownEpsilon: 3 });
  assert.equal(v.accepted, false);
  assert.match(v.reason, /pixel/i);
});

test('equal speed but memory saved → accepted/leaner', () => {
  const v = evaluate({ ...base, saved_pct: -1, rss_delta_mb: -40 }, { butteraugliThreshold: 1.0, slowdownEpsilon: 3 });
  assert.equal(v.accepted, true);
  assert.equal(v.accept_reason, 'leaner');
});

test('slightly slower but removes duplication → accepted/simpler', () => {
  const v = evaluate({ ...base, saved_pct: -2, removes_dup: true }, { butteraugliThreshold: 1.0, slowdownEpsilon: 3 });
  assert.equal(v.accepted, true);
  assert.equal(v.accept_reason, 'simpler');
});

test('added fallback pathway, primary unchanged → accepted/feature', () => {
  const v = evaluate({ ...base, saved_pct: -1, role: 'fallback' }, { butteraugliThreshold: 1.0, slowdownEpsilon: 3 });
  assert.equal(v.accepted, true);
  assert.equal(v.accept_reason, 'feature');
});

test('pure regression rejected', () => {
  const v = evaluate({ ...base, saved_pct: -20 }, { butteraugliThreshold: 1.0, slowdownEpsilon: 3 });
  assert.equal(v.accepted, false);
  assert.match(v.reason, /regression/i);
});
