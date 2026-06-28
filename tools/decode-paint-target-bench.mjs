// decode-paint-target-bench.mjs — measure the progressive paint-target schedule
// and (A/B) the reusable-ProcessSections-scratch refactor.
//
// WHAT IT MEASURES
//   For each progressivePaintTarget in {0(=per-pass),2,3,4,5,6}:
//     - number of 'progress' (intermediate paint) events emitted
//     - time-to-first-paint (ms)
//     - total decode time (ms, median of K runs)
//   With JXL_DEC_MODULE_BASELINE set, it also times a baseline module on the
//   same inputs so the scratch-refactor delta can be read as a module-level A/B
//   (the paint-target sweep is meaningful only on the PATCHED module that
//   exports _jxl_wasm_dec_set_paint_target).
//
// USAGE
//   bun tools/decode-paint-target-bench.mjs [file1.jxl file2.jxl ...]
//   JXL_DEC_MODULE=dist/jxl-core.dec.simd.js \
//   JXL_DEC_MODULE_BASELINE=dist-baseline/jxl-core.dec.simd.js \
//     bun tools/decode-paint-target-bench.mjs
//
// NOTE The shipped dist/jxl-core.dec.simd.js is built from upstream libjxl
//   v0.11.2 (scripts/build.mjs clones the pinned tag), so it will NOT contain
//   the paint-target symbol until a dec module is built from external/libjxl-012.
//   The bench reports the symbol presence up front.

import { performance } from 'node:perf_hooks';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDecoder, setJxlModuleFactoryForTesting } from '../packages/jxl-wasm/src/index.ts';

const PKG = new URL('../packages/jxl-wasm/', import.meta.url);
const RUNS = Number(process.env.JXL_BENCH_RUNS ?? 5);
const TARGETS = [0, 2, 3, 4, 5, 6]; // 0 == per-pass (legacy)

const DEFAULT_FILES = [
  new URL('../docs/Benchmark results/P2200619-prog-p6-q85.jxl', import.meta.url),
  new URL('../docs/Benchmark results/P2200674-prog-p6-q85.jxl', import.meta.url),
];

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function loadModule(relPath) {
  const url = new URL(relPath, PKG);
  const baseUrl = new URL('./', url);
  const imported = await import(url.href);
  const factory = imported.default;
  if (typeof factory !== 'function') throw new Error(`no default factory in ${relPath}`);
  const module = await factory({ locateFile: (p) => new URL(p, baseUrl).href });
  if (!module || typeof module._malloc !== 'function') throw new Error(`bad module ${relPath}`);
  return module;
}

async function decodeOnce(file, paintTarget) {
  const opts = {
    format: 'rgba8', region: null, downsample: 1,
    progressionTarget: 'final', emitEveryPass: true,
    progressiveDetail: 'passes', preserveIcc: false, preserveMetadata: false,
  };
  if (paintTarget > 0) opts.progressivePaintTarget = paintTarget;
  const dec = createDecoder(opts);
  let tFirst = null, nProgress = 0;
  const t0 = performance.now();
  dec.push(file);
  dec.close();
  for await (const ev of dec.events()) {
    if (ev.type === 'progress') { nProgress++; if (tFirst === null) tFirst = performance.now() - t0; }
    else if (ev.type === 'error') { await dec.dispose().catch(() => {}); throw new Error(ev.message); }
  }
  const total = performance.now() - t0;
  await dec.dispose().catch(() => {});
  return { nProgress, tFirst, total };
}

async function benchModule(label, relPath, files) {
  const module = await loadModule(relPath);
  const hasSym = typeof module._jxl_wasm_dec_set_paint_target === 'function';
  setJxlModuleFactoryForTesting(async () => module);
  console.log(`\n=== ${label}: ${relPath} ===`);
  console.log(`    paint-target symbol: ${hasSym ? 'YES' : 'NO — schedule control inert (rebuild dec from external/libjxl-012)'}`);

  for (const fileUrl of files) {
    const path = fileURLToPath(fileUrl);
    if (!existsSync(path)) { console.log(`    [skip] missing ${path}`); continue; }
    const buf = new Uint8Array(readFileSync(path));
    console.log(`\n  ${path.split(/[\\/]/).pop()}  (${(buf.byteLength / 1024).toFixed(1)} KiB)`);
    console.log(`    target | paints | 1st-paint ms | total ms (median of ${RUNS})`);
    // warmup
    try { await decodeOnce(buf, 0); } catch (e) { console.log(`    [warmup error] ${e.message}`); continue; }
    for (const target of TARGETS) {
      const totals = [], firsts = [];
      let paints = 0;
      for (let i = 0; i < RUNS; i++) {
        const r = await decodeOnce(buf, target);
        totals.push(r.total); firsts.push(r.tFirst ?? NaN); paints = r.nProgress;
      }
      const tag = target === 0 ? 'per-pass' : String(target);
      console.log(`    ${tag.padStart(8)} | ${String(paints).padStart(6)} | ${median(firsts).toFixed(1).padStart(12)} | ${median(totals).toFixed(2).padStart(10)}`);
    }
  }
  return module;
}

async function main() {
  const argv = process.argv.slice(2);
  const files = argv.length ? argv.map((p) => new URL(`file://${p.replace(/\\/g, '/')}`)) : DEFAULT_FILES;
  const patched = process.env.JXL_DEC_MODULE ?? 'dist/jxl-core.dec.simd.js';
  const baseline = process.env.JXL_DEC_MODULE_BASELINE;

  await benchModule('PATCHED', patched, files);
  if (baseline) await benchModule('BASELINE', baseline, files);

  console.log('\nRead: with the paint-target symbol present, lower targets should cut');
  console.log('"paints" and total decode time (fewer force-draw flushes) while keeping or');
  console.log('improving 1st-paint. Scratch A/B: compare PATCHED vs BASELINE total ms at');
  console.log('target=per-pass (identical pixels; the delta is the alloc-churn saving).');
}

main().catch((e) => { console.error(e); process.exit(1); });
