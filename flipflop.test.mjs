import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  writeFileSync, mkdtempSync, rmSync,
  readFileSync as rf, rmSync as rms, mkdtempSync as mkd,
  mkdtempSync as mkd2, readFileSync as rf2, rmSync as rms2,
} from 'node:fs';
import { tmpdir, tmpdir as td, tmpdir as td2 } from 'node:os';
import { join, join as pj, join as pj2 } from 'node:path';
import { toonVal, toonKv, toonBlock, toonTable, buildRecord, firstPaintOfDay } from './flipflop-journal.mjs';
import { renderFractal, sha1Hex, FRACTAL_KEYS, writeTiffRgb, resolveInputs, loadItem } from './flipflop-corpus.mjs';
import { memSnapshot, nearestSample, throttleVerdict, startSampler } from './flipflop-metrics.mjs';
import {
  median, stdev, geomean, percentile, savedPct, calibrate, runFlip,
  rotate, pickBaseline, detectMode, roundsFor, buildVerdict, computeSummary, runTest,
} from './flipflop.mjs';

// ---- Task 1 ----
test('scaffold: node:test runs', () => {
  assert.equal(1 + 1, 2);
});

// ---- Task 2: TOON helpers ----
test('toonVal quotes only when needed', () => {
  assert.equal(toonVal('mandel'), 'mandel');
  assert.equal(toonVal(42), '42');
  assert.equal(toonVal(true), 'true');
  assert.equal(toonVal(NaN), 'n/a');
  assert.equal(toonVal(null), 'n/a');
  assert.equal(toonVal('a,b'), '"a,b"');             // comma → quoted (table-safe)
  assert.equal(toonVal('has space'), 'has space');   // interior space → bare (journal style)
  assert.equal(toonVal(' lead'), '" lead"');         // leading space → quoted
  assert.equal(toonVal('trust:high'), '"trust:high"'); // colon → quoted
});

test('toonKv / toonBlock indent', () => {
  assert.equal(toonKv('name', 'x'), 'name: x\n');
  assert.equal(toonBlock('env', { a: 1, b: 'two' }), 'env:\n  a: 1\n  b: two\n');
});

test('toonTable emits [N]{cols} header + rows', () => {
  const out = toonTable('summary', ['size', 'variant', 'ms'], [
    { size: 256, variant: 'a', ms: 1.5 },
    { size: 256, variant: 'b', ms: 0.5 },
  ]);
  assert.equal(out, 'summary[2]{size,variant,ms}:\n  256,a,1.5\n  256,b,0.5\n');
});

// ---- Task 3: record builder + firstPaintOfDay ----
test('buildRecord starts with delimiter and contains tables', () => {
  const text = buildRecord({
    ts: '2026-06-18T14:22:05Z', name: 'demo', description: 'd',
    first_paint_of_day: true,
    env: { commit: 'abc', host: 'H', cpu: 'CPU', cores: 8, node: 'v24', gc_exposed: false, os: 'Win' },
    config: { variants: 'a,b', baseline: 'a', timing_mode: 'sync', input_source: 'fractal', rounds: '256:10', min_sample_ms: 2, sampler_ms: 500 },
    summaryCols: ['input', 'variant', 'median_warm_ms', 'saved_pct', 'trust'],
    summary: [{ input: 'mandel@256', variant: 'a', median_warm_ms: 1, saved_pct: 0, trust: 'high' }],
    flipsCols: ['input', 'round', 'variant', 'ms', 'rss_mb', 'temp_c', 'freq_ratio', 'first_paint'],
    flips: [{ input: 'mandel@256', round: 0, variant: 'a', ms: 1, rss_mb: 100, temp_c: 50, freq_ratio: 0.99, first_paint: true }],
    thermal: { temp_c_start: 50, temp_c_end: 50, temp_c_max: 50, freq_ratio_min: 0.99, throttled: false, variance_flag: false },
    verdict: 'demo verdict',
  });
  assert.match(text, /^=== flipflop 2026-06-18T14:22:05Z demo ===\n/);
  assert.match(text, /\nschema: flipflop\/v1\n/);
  assert.match(text, /\nsummary\[1\]\{input,variant,median_warm_ms,saved_pct,trust\}:\n/);
  assert.match(text, /\nflips\[1\]\{/);
  assert.match(text, /\nverdict: demo verdict\n/);
});

test('firstPaintOfDay true when no record for date', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-'));
  const jp = join(dir, 'j.toon');
  assert.equal(firstPaintOfDay(jp, '2026-06-18'), true);
  writeFileSync(jp, '=== flipflop x demo ===\nts: 2026-06-17T01:00:00Z\nverdict: v\n');
  assert.equal(firstPaintOfDay(jp, '2026-06-18'), true);
  assert.equal(firstPaintOfDay(jp, '2026-06-17'), false);
  rmSync(dir, { recursive: true, force: true });
});

// ---- Task 4: renderers + hash ----
test('fractal types are the three expected', () => {
  assert.deepEqual(FRACTAL_KEYS, ['mandel', 'fbm', 'branch']);
});

test('renderFractal returns RGBA Uint8 of right length, alpha 255', () => {
  const { rgba, width, height } = renderFractal('mandel', 64);
  assert.equal(width, 64);
  assert.equal(height, 64);
  assert.equal(rgba.length, 64 * 64 * 4);
  assert.equal(rgba[3], 255);
  assert.equal(rgba[rgba.length - 1], 255);
});

test('renderFractal is deterministic and differs by type', () => {
  const a = sha1Hex(renderFractal('mandel', 128).rgba);
  const b = sha1Hex(renderFractal('mandel', 128).rgba);
  const c = sha1Hex(renderFractal('fbm', 128).rgba);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

// ---- Task 5: TIFF writer ----
test('writeTiffRgb emits a little-endian baseline TIFF with correct size', () => {
  const w = 4, h = 3;
  const rgba = new Uint8Array(w * h * 4).fill(200);
  for (let i = 0; i < w * h; i++) rgba[i * 4 + 3] = 255;
  const dir = mkd(pj(td(), 'fftiff-'));
  const p = pj(dir, 't.tiff');
  writeTiffRgb(p, rgba, w, h);
  const b = rf(p);
  assert.equal(b.toString('ascii', 0, 2), 'II');
  assert.equal(b.readUInt16LE(2), 42);
  assert.equal(b.length, 8 + 126 + 6 + w * h * 3);
  rms(dir, { recursive: true, force: true });
});

// ---- Task 6: input resolution ----
test('resolveInputs default = types x sizes fractal descriptors (no pixels yet)', async () => {
  const items = await resolveInputs({ test: {}, types: ['mandel', 'fbm'], sizes: [64, 128] });
  assert.equal(items.length, 4);
  assert.equal(items[0].name, 'mandel@64');
  assert.equal(items[0].kind, 'fractal');
  assert.equal(items[0].rgba, undefined);
});

test('resolveInputs honors test.corpus() over fractals', async () => {
  const tdef = { corpus: () => [{ name: 'x', kind: 'file', size: 10, bytes: new Uint8Array(10) }] };
  const items = await resolveInputs({ test: tdef, types: ['mandel'], sizes: [64] });
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'x');
});

test('loadItem populates rgba for fractal descriptor', () => {
  const item = { name: 'mandel@64', kind: 'fractal', type: 'mandel', size: 64 };
  const loaded = loadItem(item);
  assert.equal(loaded.rgba.length, 64 * 64 * 4);
  assert.equal(loaded.width, 64);
});

// ---- Task 7: metric helpers ----
test('memSnapshot returns positive rss/heap in MB', () => {
  const m = memSnapshot();
  assert.ok(m.rss_mb > 0);
  assert.ok(m.heap_mb > 0);
});

test('nearestSample picks closest by timestamp', () => {
  const samples = [{ t: 0, cpu: 10, freq: 0.9, temp: 50 }, { t: 1000, cpu: 20, freq: 0.8, temp: 60 }];
  assert.equal(nearestSample(samples, 100).temp, 50);
  assert.equal(nearestSample(samples, 900).temp, 60);
  assert.deepEqual(nearestSample([], 5), { cpu: 'n/a', freq: 'n/a', temp: 'n/a' });
});

test('throttleVerdict flags low freq', () => {
  const ok = throttleVerdict([{ t: 0, cpu: 5, freq: 0.99, temp: 50 }, { t: 1, cpu: 5, freq: 0.97, temp: 55 }]);
  assert.equal(ok.throttled, false);
  assert.equal(ok.freq_ratio_min, 0.97);
  const bad = throttleVerdict([{ t: 0, cpu: 5, freq: 0.99, temp: 50 }, { t: 1, cpu: 5, freq: 0.80, temp: 88 }]);
  assert.equal(bad.throttled, true);
  const none = throttleVerdict([]);
  assert.equal(none.throttled, 'unknown');
  // static freq (Current==Max always) + no temp → uninformative, must report unknown not false
  const staticFreq = throttleVerdict([{ t: 0, cpu: 5, freq: 1, temp: 'n/a' }, { t: 1, cpu: 5, freq: 1, temp: 'n/a' }]);
  assert.equal(staticFreq.throttled, 'unknown');
});

// ---- Task 8: sampler (smoke) ----
test('startSampler returns a stoppable handle and never throws', async () => {
  const s = startSampler({ intervalMs: 300 });
  assert.equal(typeof s.stop, 'function');
  await new Promise((r) => setTimeout(r, 800));
  s.stop();
  assert.ok(Array.isArray(s.samples));
  assert.ok(s.ok === true || s.ok === false);
});

// ---- Task 9: stats + calibrate + runFlip ----
test('stats helpers', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(percentile([1, 2, 3, 4, 5], 95), 5);
  assert.ok(Math.abs(geomean([1, 4]) - 2) < 1e-9);
  assert.ok(stdev([2, 2, 2]) === 0);
  assert.equal(savedPct(10, 5), 50);
  assert.equal(savedPct(10, 20), -100);
});

test('calibrate grows innerReps until min-sample-ms', () => {
  const fast = { run: () => { let s = 0; for (let i = 0; i < 50; i++) s += i; return s; } };
  const reps = calibrate(fast, 0, { mark() {} }, 2);
  assert.ok(reps >= 1);
});

test('runFlip async awaits and returns ms + marks', async () => {
  const v = { run: async (_in, ctx) => { ctx.mark('half'); await new Promise((r) => setTimeout(r, 5)); return 7; } };
  const ctx = { mark() {} };
  const res = await runFlip(v, 0, ctx, 1, 'async');
  assert.ok(res.ms >= 4);
  assert.equal(res.out, 7);
  assert.ok('half' in res.marks);
});

test('runFlip sync sign: double-work ~2x of half-work', async () => {
  const work = (n) => { let s = 0; for (let i = 0; i < n; i++) s += Math.sqrt(i); return s; };
  const a = { run: () => work(200000) };
  const b = { run: () => work(100000) };
  const ra = await runFlip(a, 0, { mark() {} }, 1, 'sync');
  const rb = await runFlip(b, 0, { mark() {} }, 1, 'sync');
  assert.ok(ra.ms > rb.ms);
});

// ---- Task 10: engine helpers ----
test('rotate shifts start variant by round', () => {
  const v = ['a', 'b', 'c'];
  assert.deepEqual(rotate(v, 0), ['a', 'b', 'c']);
  assert.deepEqual(rotate(v, 1), ['b', 'c', 'a']);
  assert.deepEqual(rotate(v, 2), ['c', 'a', 'b']);
});

test('pickBaseline prefers baseline:true else first', () => {
  assert.equal(pickBaseline([{ name: 'a' }, { name: 'b', baseline: true }]).name, 'b');
  assert.equal(pickBaseline([{ name: 'a' }, { name: 'b' }]).name, 'a');
});

test('detectMode async if any AsyncFunction or isAsync', () => {
  assert.equal(detectMode({ variants: [{ run: () => 1 }] }), 'sync');
  assert.equal(detectMode({ variants: [{ run: async () => 1 }] }), 'async');
  assert.equal(detectMode({ isAsync: true, variants: [{ run: () => 1 }] }), 'async');
});

test('roundsFor: fractal by size, custom default 8', () => {
  assert.equal(roundsFor({ kind: 'fractal', size: 256 }, null), 10);
  assert.equal(roundsFor({ kind: 'fractal', size: 4096 }, null), 5);
  assert.equal(roundsFor({ kind: 'file' }, null), 8);
  assert.equal(roundsFor({ kind: 'fractal', size: 256 }, { 256: 3 }), 3);
});

test('computeSummary marks first_paint excluded from median_warm', () => {
  const flips = [
    { input: 'i', round: 0, variant: 'a', ms: 100, first_paint: true },
    { input: 'i', round: 1, variant: 'a', ms: 10, first_paint: false },
    { input: 'i', round: 2, variant: 'a', ms: 10, first_paint: false },
    { input: 'i', round: 0, variant: 'b', ms: 50, first_paint: true },
    { input: 'i', round: 1, variant: 'b', ms: 5, first_paint: false },
    { input: 'i', round: 2, variant: 'b', ms: 5, first_paint: false },
  ];
  const rows = computeSummary(flips, [{ name: 'a', baseline: true }, { name: 'b' }], {}, {});
  const a = rows.find((r) => r.variant === 'a'), b = rows.find((r) => r.variant === 'b');
  assert.equal(a.median_warm_ms, 10);
  assert.equal(b.median_warm_ms, 5);
  assert.equal(b.saved_pct, 50);
});

test('buildVerdict reports best primary + fallback framing', () => {
  const summary = [
    { input: 'i', variant: 'base', role: 'primary', median_warm_ms: 10, saved_pct: 0, trust: 'high', quality_ok: true },
    { input: 'i', variant: 'cand', role: 'primary', median_warm_ms: 7, saved_pct: 30, trust: 'high', quality_ok: true },
    { input: 'i', variant: 'old', role: 'fallback', median_warm_ms: 14, saved_pct: -40, trust: 'high', quality_ok: true },
  ];
  const v = buildVerdict(summary, 'base', { throttled: false });
  assert.match(v, /cand/);
  assert.match(v, /fallback/);
});

// ---- Task 11: orchestration ----
test('runTest on double fixture yields negative saved_pct and a record', async () => {
  const mod = await import('./.flipflop/tests/selftest-double.mjs');
  const rec = await runTest(mod, {
    types: ['mandel'], sizes: [64], rounds: 4, minSampleMs: 1,
    noMetrics: true, journal: null,
  });
  const dbl = rec.summary.find((r) => r.variant === 'double');
  assert.ok(dbl.saved_pct < -50, `expected <-50, got ${dbl.saved_pct}`);
  assert.equal(rec.config.timing_mode, 'sync');
  assert.ok(rec.flips.length > 0);
});

// ---- Task 12: journal write + identical sanity + determinism ----
test('identical variants => saved_pct ~ 0 and journal record appended', async () => {
  const dir = mkd2(pj2(td2(), 'ffj-'));
  const jp = pj2(dir, 'j.toon');
  // Same fn ref for both → genuinely identical; heavy work + many rounds so median converges.
  const heavy = () => { let s = 0; for (let i = 0; i < 2_000_000; i++) s += Math.sqrt(i); return s; };
  const tdef = {
    name: 'ident', description: 'identical variants',
    variants: [
      { name: 'a', baseline: true, run: heavy },
      { name: 'b', run: heavy },
    ],
  };
  const rec = await runTest(tdef, { types: ['mandel'], sizes: [64], rounds: 12, minSampleMs: 1, noMetrics: true, journal: jp });
  const b = rec.summary.find((r) => r.variant === 'b');
  assert.ok(Math.abs(b.saved_pct) < 25, `expected ~0, got ${b.saved_pct}`);
  const txt = rf2(jp, 'utf8');
  assert.match(txt, /^=== flipflop .* ident ===/m);
  assert.match(txt, /\nverdict: /);
  rms2(dir, { recursive: true, force: true });
});

test('fractal corpus hashes match committed reference', async () => {
  const ref = JSON.parse(rf2(new URL('./flipflop-corpus-hashes.json', import.meta.url), 'utf8'));
  for (const [key, hash] of Object.entries(ref)) {
    const [type, size] = key.split('@');
    assert.equal(sha1Hex(renderFractal(type, +size).rgba), hash, `hash drift for ${key}`);
  }
});
