// benchmark/metrics-flipflop.mjs
// Run: bun benchmark/metrics-flipflop.mjs
// Measures: buildSeries (JS ref-cached butter) vs WASM-single-shot vs WASM ref-cached, 10x each
// Pixel size: 512×512, 4 cutoff frames
import { performance } from 'node:perf_hooks';
import { computePsnrVsFinal, computeSsimVsFinal } from '../web/jxl-progressive-quality.js';
import { createButteraugliComparer } from '../web/jxl-butteraugli.js';

const W = 512, H = 512, N = 4;

function makePixels(seed) {
  const p = new Uint8Array(W * H * 4);
  let x = seed | 1;
  for (let i = 0; i < p.length; i += 4) {
    x ^= x << 13; x ^= x >> 17; x ^= x << 5;
    const v = (x >>> 0) % 256;
    p[i] = v; p[i + 1] = (v + 30) % 256; p[i + 2] = (v + 60) % 256; p[i + 3] = 255;
  }
  return p;
}

function buildSeriesJS(refPixels, cuts, sizes) {
  const cmp = createButteraugliComparer(refPixels, W, H);
  const qualitySeries = [], butterSeries = [], ssimSeries = [];
  for (let i = 0; i < cuts.length; i++) {
    const p = cuts[i], b = sizes[i];
    qualitySeries.push({ bytes: b, psnr: computePsnrVsFinal(p, refPixels) });
    butterSeries.push({ bytes: b, butter: cmp(p) });
    ssimSeries.push({ bytes: b, ssim: computeSsimVsFinal(p, refPixels, W, H) });
  }
  return { qualitySeries, butterSeries, ssimSeries };
}

function runTrials(label, fn, warmup, trials) {
  for (let i = 0; i < warmup; i++) fn();
  const times = [];
  for (let i = 0; i < trials; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  const sorted = [...times].sort((a, b) => a - b);
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const med = sorted[Math.floor(sorted.length / 2)];
  console.log(`${label}:\n  mean=${mean.toFixed(2)}ms  med=${med.toFixed(2)}ms  min=${sorted[0].toFixed(2)}ms  max=${sorted[sorted.length - 1].toFixed(2)}ms  (${trials} trials)`);
  return { mean, med, min: sorted[0], max: sorted[sorted.length - 1], times };
}

const TRIALS = 10, WARMUP = 2;

const ref = makePixels(42);
const cuts = Array.from({ length: N }, (_, i) => makePixels(i * 17 + 1));
const sizes = cuts.map((_, i) => (i + 1) * 10_000);

console.log(`\n=== metrics-flipflop: W=${W} H=${H} N=${N} cutoffs, ${TRIALS} trials each ===\n`);

// --- JS ref-cached ---
const jsResult = runTrials('A) JS buildSeries (ref-cached XYB pyramid + JS PSNR/SSIM)', () => buildSeriesJS(ref, cuts, sizes), WARMUP, TRIALS);

// --- WASM single-shot (existing ButteraugliComparator) ---
let wasmSingleResult = null;
let wasmRefCachedResult = null;

try {
  // Try loading facade from package dist or installed package
  const facade = await import('../packages/jxl-wasm/dist/facade.js')
    .catch(() => import('@casabio/jxl-wasm'))
    .catch(() => null);

  if (facade && facade.ButteraugliComparator) {
    // Single-shot: existing path (rebuilds ref Image3F every compare call)
    const cmpSingle = await facade.ButteraugliComparator.create(ref, W, H);
    // Warmup
    for (let i = 0; i < WARMUP; i++) for (const c of cuts) { computePsnrVsFinal(c, ref); cmpSingle.compare(c); computeSsimVsFinal(c, ref, W, H); }
    wasmSingleResult = runTrials('B) WASM single-shot ButteraugliComparator (ref Image3F rebuilt each call)', () => {
      for (let i = 0; i < cuts.length; i++) {
        computePsnrVsFinal(cuts[i], ref);
        cmpSingle.compare(cuts[i]);
        computeSsimVsFinal(cuts[i], ref, W, H);
      }
    }, 0, TRIALS);
    cmpSingle.dispose();

    // Ref-cached: new path (Task D — jxl_wasm_butteraugli_ref_compare)
    // Check if new API available
    const mod = (facade._getModuleForTest?.()) ?? null;
    const hasRefCached = mod && typeof mod._jxl_wasm_butteraugli_ref_create === 'function';
    if (hasRefCached) {
      const cmpRef = await facade.ButteraugliComparator.create(ref, W, H);
      for (let i = 0; i < WARMUP; i++) for (const c of cuts) cmpRef.compare(c);
      wasmRefCachedResult = runTrials('C) WASM ref-cached ButteraugliComparator (Task D — only test Image3F rebuilt)', () => {
        for (let i = 0; i < cuts.length; i++) {
          computePsnrVsFinal(cuts[i], ref);
          cmpRef.compare(cuts[i]);
          computeSsimVsFinal(cuts[i], ref, W, H);
        }
      }, 0, TRIALS);
      cmpRef.dispose();
    } else {
      console.log('C) WASM ref-cached: not yet available (run after Task C rebuild)');
    }
  } else {
    console.log('B) WASM facade not importable in this env — run in browser or after package build');
    console.log('   Expected single-shot: ~2-5× SLOWER than JS for batch (ref rebuilt every call)');
    console.log('   Expected ref-cached:  ~1.5-3× FASTER than JS (only test Image3F built per call)');
  }
} catch (e) {
  console.log('WASM trials skipped:', e.message);
}

// --- Summary ---
console.log('\n=== SUMMARY ===');
console.log(`A) JS ref-cached: mean=${jsResult.mean.toFixed(2)}ms`);
if (wasmSingleResult) {
  const r1 = jsResult.mean / wasmSingleResult.mean;
  console.log(`B) WASM single-shot: mean=${wasmSingleResult.mean.toFixed(2)}ms  [JS/WASM-single = ${r1.toFixed(2)}×]`);
}
if (wasmRefCachedResult) {
  const r2 = jsResult.mean / wasmRefCachedResult.mean;
  console.log(`C) WASM ref-cached: mean=${wasmRefCachedResult.mean.toFixed(2)}ms  [JS/WASM-ref = ${r2.toFixed(2)}×${r2 > 1 ? ' — WASM faster' : ' — JS faster'}]`);
}
console.log('\nRecord these numbers in docs/superpowers/plans/2026-06-14-max-perf-facade-metrics.md Task A baseline.');
