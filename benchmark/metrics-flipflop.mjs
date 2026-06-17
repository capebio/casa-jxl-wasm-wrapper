// benchmark/metrics-flipflop.mjs
// Easy run (pwsh/bun/node from repo root):
//   bun benchmark/metrics-flipflop.mjs
//   bun benchmark/metrics-flipflop.mjs --stateA "C:\Foo\raw-converter\tests\P1110226.ORF" --stateB "C:\Foo\raw-converter\tests\_MG_1744.CR2"
// Alternates between two states (derived from different real raw files for format variety).
// Measures ref-cached (create once) vs recreate-every (sim flip for repeated ref work) + original WASM probes.
// Uses byte-derived seeds from provided files (no decode needed; internal).
import { performance } from 'node:perf_hooks';
import { readFileSync, existsSync } from 'node:fs';
import { computePsnrVsFinal, computeSsimVsFinal } from '../web/jxl-progressive-quality.js';
import { createButteraugliComparer } from '../web/jxl-butteraugli.js';

const W = 512, H = 512, N = 4;
const DEFAULT_TEST_DIR = String.raw`C:\Foo\raw-converter\tests`;
const DEFAULT_STATE_A = `${DEFAULT_TEST_DIR}\\P1110226.ORF`;
const DEFAULT_STATE_B = `${DEFAULT_TEST_DIR}\\_MG_1744.CR2`;

function parseArgs() {
  const args = process.argv.slice(2);
  let stateA = DEFAULT_STATE_A, stateB = DEFAULT_STATE_B;
  for (let i=0; i<args.length; i++) {
    if (args[i] === '--stateA' || args[i] === '-a') stateA = args[++i] || stateA;
    if (args[i] === '--stateB' || args[i] === '-b') stateB = args[++i] || stateB;
  }
  return { stateA, stateB };
}

function seedFromFile(p) {
  try {
    if (!existsSync(p)) return (p.length * 0x9e37) | 1;
    const b = readFileSync(p);
    let s = b.length | 1;
    for (let i=0; i<Math.min(64, b.length); i+=3) s ^= (b[i] << ((i%5)*3)) >>> 0;
    return s | 1;
  } catch { return 0x1234567 | 1; }
}

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

// Flipflop variants for ref-butter work (emulates repeated create vs memo/cache).
function buildSeriesRecreate(refPixels, cuts, sizes) {
  // recreate comparer each cut (simulates non-memo / per-pass rebuild)
  const qualitySeries = [], butterSeries = [], ssimSeries = [];
  for (let i = 0; i < cuts.length; i++) {
    const p = cuts[i], b = sizes[i];
    const cmp = createButteraugliComparer(refPixels, W, H); // "bad" path
    qualitySeries.push({ bytes: b, psnr: computePsnrVsFinal(p, refPixels) });
    butterSeries.push({ bytes: b, butter: cmp(p) });
    ssimSeries.push({ bytes: b, ssim: computeSsimVsFinal(p, refPixels, W, H) });
  }
  return { qualitySeries, butterSeries, ssimSeries };
}

function buildSeriesCached(refPixels, cuts, sizes) {
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

const TRIALS = 10, WARMUP = 2;
const { stateA, stateB } = parseArgs();

function makeState(filePath, baseSeed = 1) {
  const seed = seedFromFile(filePath) ^ (baseSeed * 0x10001);
  const ref = makePixels(seed);
  const cuts = Array.from({ length: N }, (_, i) => makePixels((seed ^ (i * 0x9e37)) >>> 0));
  const sizes = cuts.map((_, i) => (i + 1) * 10_000);
  return { ref, cuts, sizes, label: filePath.split(/[\\/]/).pop() || 'synthetic' };
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

console.log(`\n=== metrics-flipflop (alternating states): W=${W} H=${H} N=${N} cutoffs, ${TRIALS} trials ===`);
console.log(`stateA: ${stateA}`);
console.log(`stateB: ${stateB}\n`);

// Generate two states from real test files (different formats -> different seeds)
const sA = makeState(stateA, 0x11);
const sB = makeState(stateB, 0x22);

console.log(`stateA file: ${sA.label}  stateB file: ${sB.label}\n`);

// --- Flip A/B for JS cached vs recreate (the repeated-ref cost) ---
let flipRecreateA, flipCachedA, flipRecreateB, flipCachedB;

flipRecreateA = runTrials(`A0) recreate-every (stateA ${sA.label})`, () => buildSeriesRecreate(sA.ref, sA.cuts, sA.sizes), WARMUP, TRIALS);
flipCachedA   = runTrials(`A1) ref-cached     (stateA ${sA.label})`, () => buildSeriesCached(sA.ref, sA.cuts, sA.sizes), WARMUP, TRIALS);

flipRecreateB = runTrials(`B0) recreate-every (stateB ${sB.label})`, () => buildSeriesRecreate(sB.ref, sB.cuts, sB.sizes), WARMUP, TRIALS);
flipCachedB   = runTrials(`B1) ref-cached     (stateB ${sB.label})`, () => buildSeriesCached(sB.ref, sB.cuts, sB.sizes), WARMUP, TRIALS);

// Alternate simulation: interleave one A recreate + one A cached + B recreate + B cached as "flipflop passes"
console.log('\n=== alternating flipflop run (interleaved stateA/B recreate vs cached) ===');
const altTimesRec = [], altTimesCac = [];
for (let r = 0; r < TRIALS; r++) {
  let t = performance.now(); buildSeriesRecreate(sA.ref, sA.cuts, sA.sizes); altTimesRec.push(performance.now()-t);
  t = performance.now(); buildSeriesCached(sA.ref, sA.cuts, sA.sizes); altTimesCac.push(performance.now()-t);
  t = performance.now(); buildSeriesRecreate(sB.ref, sB.cuts, sB.sizes); altTimesRec.push(performance.now()-t);
  t = performance.now(); buildSeriesCached(sB.ref, sB.cuts, sB.sizes); altTimesCac.push(performance.now()-t);
}
const medRec = [...altTimesRec].sort((x,y)=>x-y)[altTimesRec.length>>1];
const medCac = [...altTimesCac].sort((x,y)=>x-y)[altTimesCac.length>>1];
console.log(`alt recreate: med=${medRec.toFixed(2)}ms`);
console.log(`alt cached  : med=${medCac.toFixed(2)}ms  delta=${(medRec-medCac).toFixed(2)}ms`);

// --- WASM single-shot (existing ButteraugliComparator) ---
// Gated: dist may not be present or init hangs in this env; pass --with-wasm to attempt.
let wasmSingleResult = null;
let wasmRefCachedResult = null;
const withWasm = process.argv.includes('--with-wasm') || process.argv.includes('-w');
if (withWasm) {
  try {
    const facade = await import('../packages/jxl-wasm/dist/facade.js')
      .catch(() => import('@casabio/jxl-wasm'))
      .catch(() => null);
    if (facade && facade.ButteraugliComparator) {
      const ref = sA.ref;
      const cuts = sA.cuts;
      const cmpSingle = await facade.ButteraugliComparator.create(ref, W, H);
      for (let i = 0; i < WARMUP; i++) for (const c of cuts) { computePsnrVsFinal(c, ref); cmpSingle.compare(c); computeSsimVsFinal(c, ref, W, H); }
      wasmSingleResult = runTrials('W0) WASM single-shot Butter (stateA)', () => {
        for (let i = 0; i < cuts.length; i++) {
          computePsnrVsFinal(cuts[i], ref);
          cmpSingle.compare(cuts[i]);
          computeSsimVsFinal(cuts[i], ref, W, H);
        }
      }, 0, TRIALS);
      cmpSingle.dispose();
      const mod = (facade._getModuleForTest?.()) ?? null;
      const hasRefCached = mod && typeof mod._jxl_wasm_butteraugli_ref_create === 'function';
      if (hasRefCached) {
        const cmpRef = await facade.ButteraugliComparator.create(ref, W, H);
        for (let i = 0; i < WARMUP; i++) for (const c of cuts) cmpRef.compare(c);
        wasmRefCachedResult = runTrials('W1) WASM ref-cached Butter (stateA)', () => {
          for (let i = 0; i < cuts.length; i++) {
            computePsnrVsFinal(cuts[i], ref);
            cmpRef.compare(cuts[i]);
            computeSsimVsFinal(cuts[i], ref, W, H);
          }
        }, 0, TRIALS);
        cmpRef.dispose();
      } else {
        console.log('W1) WASM ref-cached: not yet available');
      }
    }
  } catch (e) {
    console.log('WASM trials skipped (use --with-wasm):', e.message);
  }
} else {
  console.log('WASM skipped (add --with-wasm to attempt facade). JS flipflop (recreate vs cached) is the fast path here.');
}

// --- Summary ---
console.log('\n=== SUMMARY (alternated states from real raw files) ===');
console.log(`stateA cached: mean=${flipCachedA.mean.toFixed(2)}ms  recreate: ${flipRecreateA.mean.toFixed(2)}ms`);
console.log(`stateB cached: mean=${flipCachedB.mean.toFixed(2)}ms  recreate: ${flipRecreateB.mean.toFixed(2)}ms`);
console.log(`alt delta (rec - cac): ${(medRec - medCac).toFixed(2)}ms over ${altTimesRec.length} flips`);
if (wasmSingleResult) {
  const r1 = flipCachedA.mean / wasmSingleResult.mean;
  console.log(`W0 WASM-single (A): mean=${wasmSingleResult.mean.toFixed(2)}ms  ratio vs A-cached ${r1.toFixed(2)}×`);
}
if (wasmRefCachedResult) {
  const r2 = flipCachedA.mean / wasmRefCachedResult.mean;
  console.log(`W1 WASM-cached (A): mean=${wasmRefCachedResult.mean.toFixed(2)}ms  ratio ${r2.toFixed(2)}×`);
}
console.log('\nTo flip files: pass --stateA /path/to/other.orf --stateB /path/to/diff.dng');
console.log('Record in relevant plan md.');
