// flipflop.mjs — flip-flop timing engine + CLI (zero deps)
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, cpus, hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import { resolveInputs, loadItem, materializeTiff } from './flipflop-corpus.mjs';
import { memSnapshot, startSampler, nearestSample, throttleVerdict } from './flipflop-metrics.mjs';
import { buildRecord, appendRecord, firstPaintOfDay } from './flipflop-journal.mjs';

const DEFAULT_JOURNAL = 'docs/outputs/timing tests/flipflop/flipflopjournal.toon';

// ---- stats ----
const sortNum = (a) => [...a].sort((x, y) => x - y);
export function median(a) { if (!a.length) return NaN; const s = sortNum(a); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
export function stdev(a) { if (a.length < 2) return 0; const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); }
export function geomean(a) { const f = a.filter((x) => x > 0); if (!f.length) return NaN; return Math.exp(f.reduce((s, x) => s + Math.log(x), 0) / f.length); }
export function percentile(a, p) { const s = sortNum(a); if (!s.length) return NaN; const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1)))); return s[i]; }
export function savedPct(base, v) { return +((1 - v / base) * 100).toFixed(1); }

export function calibrate(variant, input, ctx, minMs) {
  let reps = 1;
  for (let attempt = 0; attempt < 24; attempt++) {
    const t0 = performance.now();
    for (let i = 0; i < reps; i++) variant.run(input, ctx);
    const dt = performance.now() - t0;
    if (dt >= minMs) return reps;
    reps = dt <= 0 ? reps * 4 : Math.max(reps + 1, Math.ceil(reps * (minMs / dt) * 1.2));
  }
  return reps;
}

let _tmpSeq = 0;
function tmpOutPath() { return join(tmpdir(), `flipflop-out-${process.pid}-${_tmpSeq++}.bin`); }

export async function runFlip(variant, input, ctx, innerReps, mode) {
  const marks = {};
  let t0 = 0;
  ctx.mark = (label) => { marks[label] = +(performance.now() - t0).toFixed(3); };

  if (variant.cmd) {
    const outPath = tmpOutPath();
    const cmdline = variant.cmd.replaceAll('{input}', ctx.inputPath).replaceAll('{output}', outPath);
    t0 = performance.now();
    const res = spawnSync(cmdline, { shell: true });
    const ms = performance.now() - t0;
    if (res.status !== 0) throw new Error(`cmd exited ${res.status}: ${variant.name}`);
    const out = existsSync(outPath) ? new Uint8Array(readFileSync(outPath)) : undefined;
    return { ms, marks, out };
  }

  let out;
  if (mode === 'async') {
    t0 = performance.now();
    for (let i = 0; i < innerReps; i++) out = await variant.run(input, ctx);
    const ms = (performance.now() - t0) / innerReps;
    return { ms, marks, out };
  }
  t0 = performance.now();
  for (let i = 0; i < innerReps; i++) out = variant.run(input, ctx);
  const ms = (performance.now() - t0) / innerReps;
  return { ms, marks, out };
}

// ---- engine helpers ----
export function rotate(arr, r) { const n = arr.length, k = ((r % n) + n) % n; return arr.slice(k).concat(arr.slice(0, k)); }
export function pickBaseline(variants) { return variants.find((v) => v.baseline) || variants[0]; }
export function detectMode(test) {
  if (test.isAsync) return 'async';
  return test.variants.some((v) => v.run && v.run.constructor && v.run.constructor.name === 'AsyncFunction') ? 'async' : 'sync';
}
const DEFAULT_ROUNDS = { 256: 10, 512: 10, 1024: 10, 2048: 5, 4096: 5 };
export function roundsFor(item, override) {
  if (override && typeof override === 'object') {
    if (item.kind === 'fractal' && override[item.size] != null) return override[item.size];
    if (override[item.name] != null) return override[item.name];
    if (override.default != null) return override.default;
  }
  if (typeof override === 'number') return override;
  if (item.rounds) return item.rounds;
  if (item.kind === 'fractal') return DEFAULT_ROUNDS[item.size] ?? 8;
  return 8;
}

const TRUST_CV = 0.10;
export function computeSummary(flips, variants, quality, equality) {
  const baseName = pickBaseline(variants).name;
  const byInput = [...new Set(flips.map((f) => f.input))];
  const rows = [];
  const baseMed = {};                // per input → baseline median_warm
  for (const input of byInput) {
    const bf = flips.filter((f) => f.input === input && f.variant === baseName);
    const warm = bf.filter((f) => !f.first_paint).map((f) => f.ms).filter(Number.isFinite);
    const all = bf.map((f) => f.ms).filter(Number.isFinite);
    baseMed[input] = median(warm.length ? warm : all);
  }
  for (const input of byInput) {
    for (const v of variants) {
      const vf = flips.filter((f) => f.input === input && f.variant === v.name);
      if (!vf.length) continue;
      const all = vf.map((f) => f.ms).filter(Number.isFinite);
      if (!all.length) {            // every flip failed
        rows.push({ input, variant: v.name, role: v.role || 'primary', median_warm_ms: 'n/a', median_all_ms: 'n/a', min_ms: 'n/a', stdev_ms: 'n/a', saved_pct: 'n/a', quality: 'n/a', quality_ok: false, trust: 'low' });
        continue;
      }
      const warmArr = vf.filter((f) => !f.first_paint).map((f) => f.ms).filter(Number.isFinite);
      const warm = warmArr.length ? warmArr : all;          // R<=2 fallback
      const mw = median(warm), sd = stdev(warm);
      const q = quality[`${input}|${v.name}`];
      const eqMiss = equality[`${input}|${v.name}`] === false;
      const trust = (sd / mw < TRUST_CV && !eqMiss) ? 'high' : 'low';
      rows.push({
        input, variant: v.name, role: v.role || 'primary',
        median_warm_ms: +mw.toFixed(3), median_all_ms: +median(all).toFixed(3),
        min_ms: +Math.min(...all).toFixed(3), stdev_ms: +sd.toFixed(3),
        saved_pct: v.name === baseName ? 0 : savedPct(baseMed[input], mw),
        quality: q === undefined ? 'n/a' : +Number(q).toFixed(3),
        quality_ok: q === undefined ? true : !!quality[`${input}|${v.name}|ok`],
        trust,
      });
    }
  }
  return rows;
}

export function buildVerdict(summary, baseName, thermal) {
  const primaries = [...new Set(summary.filter((r) => r.variant !== baseName && r.role === 'primary').map((r) => r.variant))];
  const geoSaved = (name) => {
    const recs = summary.filter((r) => r.variant === name);
    const baseRecs = summary.filter((r) => r.variant === baseName);
    const rs = recs.map((r) => {
      const b = baseRecs.find((x) => x.input === r.input);
      return (b && typeof r.median_warm_ms === 'number' && typeof b.median_warm_ms === 'number') ? r.median_warm_ms / b.median_warm_ms : null;
    }).filter((x) => x != null && x > 0);
    return rs.length ? +((1 - geomean(rs)) * 100).toFixed(1) : 0;
  };
  let parts = [];
  if (primaries.length) {
    const ranked = primaries.map((n) => ({ n, s: geoSaved(n) })).sort((a, b) => b.s - a.s);
    const best = ranked[0];
    parts.push(`${best.n} ${best.s >= 0 ? best.s + '% faster' : Math.abs(best.s) + '% slower'} vs ${baseName} (geomean median_warm)`);
  }
  const qBreaches = summary.filter((r) => r.quality_ok === false).map((r) => r.variant);
  if (qBreaches.length) parts.push(`QUALITY BREACH: ${[...new Set(qBreaches)].join(',')}`);
  const fallbacks = [...new Set(summary.filter((r) => r.role === 'fallback').map((r) => r.variant))];
  for (const fb of fallbacks) {
    const g = geoSaved(fb);
    parts.push(`${fb} role:fallback (alternative, intentional, ${g >= 0 ? g + '% faster' : Math.abs(g) + '% slower'})`);
  }
  parts.push(thermal.throttled === true ? 'THERMAL THROTTLED' : thermal.throttled === 'unknown' ? 'thermal unknown' : 'thermal stable');
  const anyLow = summary.some((r) => r.trust === 'low');
  parts.push(`trust:${anyLow ? 'low' : 'high'}`);
  return parts.join('; ');
}

// ---- orchestration ----
function gitCommit() {
  try { return spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim() || 'n/a'; }
  catch { return 'n/a'; }
}

function validateTest(t) {
  if (!t.name || !t.description) throw new Error('test must export name + description');
  if (!Array.isArray(t.variants) || t.variants.length < 2) throw new Error('test needs >= 2 variants');
  for (const v of t.variants) if (!v.name || (!v.run && !v.cmd)) throw new Error('variant needs name + run|cmd');
}

function aggregateMarks(rows) {
  const groups = {};
  for (const r of rows) { const k = `${r.input}|${r.variant}|${r.label}`; (groups[k] ??= { input: r.input, variant: r.variant, label: r.label, vals: [] }).vals.push(r.ms); }
  return Object.values(groups).map((g) => ({ input: g.input, variant: g.variant, label: g.label, median_ms: +median(g.vals).toFixed(3) }));
}

export async function runTest(test, opts) {
  validateTest(test);
  const mode = detectMode(test);
  const variants = test.variants;
  const base = pickBaseline(variants);
  const marksUsed = /ctx\.mark|\.mark\(/.test(variants.map((v) => (v.run || '').toString()).join('\n'));
  const items = await resolveInputs({ test, inputsGlob: opts.inputs, types: opts.types, sizes: opts.sizes });
  const sampler = opts.noMetrics ? { samples: [], ok: false, stop() {} } : startSampler({ intervalMs: opts.samplerMs ?? 500 });

  const flips = [];
  const quality = {};
  const equality = {};
  for (const desc of items) {
    let loaded = loadItem(desc);
    const inputPath = (variants.some((v) => v.cmd)) ? materializeTiff(loaded) : null;
    const baseInput = test.setup ? test.setup(loaded) : (loaded.rgba ?? loaded.bytes);
    const rounds = roundsFor(desc, opts.rounds);
    const round0Out = {};

    // calibrate inner-reps (sync, non-mark, non-cmd only)
    let innerReps = 1;
    if (mode === 'sync' && !marksUsed && !base.cmd) {
      innerReps = calibrate(base, baseInput, { name: desc.name, mark() {} }, opts.minSampleMs ?? 2);
    }

    for (let r = 0; r < rounds; r++) {
      for (const v of rotate(variants, r)) {
        const ctx = { name: desc.name, type: desc.type, size: desc.size, round: r, width: desc.width, height: desc.height, variantName: v.name, inputPath, mark() {} };
        let res;
        try { res = await runFlip(v, baseInput, ctx, innerReps, mode); }
        catch (e) { flips.push({ input: desc.name, round: r, variant: v.name, ms: NaN, rss_mb: 'n/a', temp_c: 'n/a', freq_ratio: 'n/a', first_paint: r === 0, failed: true }); continue; }
        const mem = memSnapshot();
        const samp = nearestSample(sampler.samples, performance.now());
        flips.push({ input: desc.name, round: r, variant: v.name, ms: +res.ms.toFixed(3), rss_mb: mem.rss_mb, temp_c: samp.temp, freq_ratio: samp.freq, first_paint: r === 0, marks: res.marks });
        if (r === 0) round0Out[v.name] = res.out;
        if (globalThis.gc) globalThis.gc();
      }
    }

    // equality + quality on round-0 outputs, then free
    const baseOut = round0Out[base.name];
    for (const v of variants) {
      if (v.name === base.name) continue;
      if (test.equal && round0Out[v.name] !== undefined && baseOut !== undefined) {
        try { equality[`${desc.name}|${v.name}`] = !!test.equal(round0Out[v.name], baseOut); } catch {}
      }
      if (test.quality && round0Out[v.name] !== undefined) {
        try {
          const q = test.quality(round0Out[v.name], baseOut, { name: desc.name });
          if (Number.isFinite(q)) {
            quality[`${desc.name}|${v.name}`] = q;
            const dir = test.qualityDirection || 'lower';
            const thr = v.qualityThreshold ?? test.qualityThreshold;
            quality[`${desc.name}|${v.name}|ok`] = thr == null ? true : (dir === 'lower' ? q <= thr : q >= thr);
          }
        } catch {}
      }
    }
    loaded = null; for (const k in round0Out) round0Out[k] = null;
  }
  sampler.stop();

  const thermal = throttleVerdict(sampler.samples);
  const summary = computeSummary(flips, variants, quality, equality);
  thermal.variance_flag = summary.some((r) => r.trust === 'low');
  const verdict = buildVerdict(summary, base.name, thermal);
  const now = new Date();
  const ts = now.toISOString().replace(/\.\d+Z$/, 'Z');
  const marksRows = flips.flatMap((f) => f.marks ? Object.entries(f.marks).map(([label, ms]) => ({ input: f.input, variant: f.variant, label, ms })) : []);
  const marksAgg = aggregateMarks(marksRows);

  const rec = {
    ts, name: test.name, description: test.description,
    first_paint_of_day: opts.journal ? firstPaintOfDay(opts.journal, ts.slice(0, 10)) : true,
    env: { commit: gitCommit(), host: hostname(), cpu: cpus()[0]?.model ?? 'n/a', cores: cpus().length, node: process.version, gc_exposed: !!globalThis.gc, os: `${process.platform}-${process.arch}` },
    config: { variants: variants.map((v) => v.name).join(','), baseline: base.name, timing_mode: mode, input_source: opts.inputs ? `--inputs (${items[0]?.kind})` : test.corpus ? 'corpus()' : 'fractal', rounds: typeof opts.rounds === 'number' ? opts.rounds : 'default', min_sample_ms: opts.minSampleMs ?? 2, sampler_ms: opts.samplerMs ?? 500 },
    summaryCols: ['input', 'variant', 'role', 'median_warm_ms', 'median_all_ms', 'min_ms', 'stdev_ms', 'saved_pct', 'quality', 'quality_ok', 'trust'],
    summary,
    marksCols: ['input', 'variant', 'label', 'median_ms'], marks: marksAgg,
    flipsCols: ['input', 'round', 'variant', 'ms', 'rss_mb', 'temp_c', 'freq_ratio', 'first_paint'],
    flips: flips.map((f) => ({ input: f.input, round: f.round, variant: f.variant, ms: f.ms, rss_mb: f.rss_mb, temp_c: f.temp_c, freq_ratio: f.freq_ratio, first_paint: f.first_paint })),
    thermal, verdict,
  };
  if (opts.journal && !opts.dry) appendRecord(opts.journal, buildRecord(rec));
  return rec;
}

function parseArgs(argv) {
  const o = { types: undefined, sizes: undefined, rounds: undefined, minSampleMs: 2, samplerMs: 500, journal: DEFAULT_JOURNAL, noMetrics: false, print: false, dry: false };
  let testFile = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--inputs') o.inputs = next();
    else if (a === '--rounds') { const r = next(); o.rounds = r.includes(':') ? Object.fromEntries(r.split(',').map((s) => s.split(':').map((x, k) => k ? +x : x.trim()))) : +r; }
    else if (a === '--sizes') o.sizes = next().split(',').map((x) => +x);
    else if (a === '--types') o.types = next().split(',');
    else if (a === '--min-sample-ms') o.minSampleMs = +next();
    else if (a === '--sampler-ms') o.samplerMs = +next();
    else if (a === '--journal') o.journal = next();
    else if (a === '--no-metrics') o.noMetrics = true;
    else if (a === '--print') o.print = true;
    else if (a === '--dry') { o.dry = true; o.rounds = o.rounds ?? 1; }
    else if (a === '--selftest') o.selftest = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (!a.startsWith('--')) testFile = a;
  }
  return { o, testFile };
}

function printSummary(rec) {
  console.log(`\nflipflop: ${rec.name} [${rec.config.timing_mode}] — ${rec.verdict}\n`);
  const cols = rec.summaryCols;
  console.log(cols.join('\t'));
  for (const row of rec.summary) console.log(cols.map((c) => row[c]).join('\t'));
}

async function main() {
  const { o, testFile } = parseArgs(process.argv.slice(2));
  if (o.help || (!testFile && !o.selftest)) {
    console.log('Usage: node [--expose-gc] flipflop.mjs <test-file> [--inputs glob] [--rounds spec] [--sizes a,b] [--types a,b] [--min-sample-ms n] [--sampler-ms n] [--journal path] [--no-metrics] [--print] [--dry]');
    if (!testFile && !o.help && !o.selftest) process.exitCode = 1;
    return;
  }
  if (o.selftest) { spawnSync(process.execPath, ['--test', 'flipflop.test.mjs'], { stdio: 'inherit' }); return; }
  const mod = await import(pathToFileURL(resolve(testFile)).href);
  const rec = await runTest(mod, o);
  if (o.print || o.dry) printSummary(rec);
  if (!o.dry) console.log(`flipflop: appended to ${o.journal}`);
}

if (process.argv[1] && process.argv[1].endsWith('flipflop.mjs')) {
  main().catch((e) => { console.error('flipflop error:', e.message); process.exitCode = 1; });
}
