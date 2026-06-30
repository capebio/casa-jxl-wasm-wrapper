// dec-suspect-bisect — 3-way WASM dec.simd flipflop to attribute the regression
// to a specific source file. OLD (10783f7e) vs NEW (00f4d7fc) vs HYBRID (NEW with
// one suspect reverted to OLD). No build inside; loads three prebuilt dec.simd dirs.
//
//   OLD    : C:/Temp/dec-flipflop-old        (full OLD)
//   NEW    : C:/Temp/dec-flipflop-new        (full NEW, preserved from dist)
//   HYBRID : env HYB_DIR (default below)      (NEW minus one reverted suspect)
//
// If HYBRID median ~= OLD median, the reverted file carries (most of) the regression.
//
//   run from packages/jxl-wasm:  HYB_DIR=C:/Temp/dec-flipflop-hybrid-decans HYB_LABEL=dec_ans bun test/dec-suspect-bisect.mts
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createDecoder, setJxlModuleFactoryForTesting } from '../src/index';

const OLD_DIR = 'C:/Temp/dec-flipflop-old';
const NEW_DIR = 'C:/Temp/dec-flipflop-new';
const HYB_DIR = process.env.HYB_DIR ?? 'C:/Temp/dec-flipflop-hybrid-decans';
const HYB_LABEL = process.env.HYB_LABEL ?? 'HYBRID';

function moduleLoader(dir: string) {
  const jsHref = pathToFileURL(`${dir}/jxl-core.dec.simd.js`).href;
  const locate = (p: string) => pathToFileURL(`${dir}/${p}`).href;
  return async () => {
    const imported = await import(jsHref);
    const factory = imported.default as (cfg: { locateFile: (p: string) => string }) => Promise<unknown>;
    return (await factory({ locateFile: locate })) as never;
  };
}

function checksum(d: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < d.length; i += 1009) s = (s + d[i]) >>> 0;
  return (s ^ d.length) >>> 0;
}

async function decodeOnce(encoded: Uint8Array) {
  const decoder = createDecoder({
    format: 'rgba8', region: null, downsample: 1,
    progressionTarget: 'final', emitEveryPass: false,
    preserveIcc: false, preserveMetadata: false,
  });
  let result: { n: number; w: number; h: number; sum: number } | null = null;
  const task = (async () => {
    for await (const ev of decoder.events()) {
      if (ev.type === 'error') throw new Error(ev.message);
      if (ev.type === 'final') {
        const d = ev.pixels instanceof Uint8Array ? ev.pixels : new Uint8Array(ev.pixels);
        result = { n: d.length, w: ev.info.width, h: ev.info.height, sum: checksum(d) };
      }
    }
  })();
  decoder.push(encoded);
  await Promise.resolve();
  decoder.close();
  await task;
  await decoder.dispose();
  if (!result) throw new Error('no final event');
  return result;
}

const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[xs.length >> 1];

const FILES: Array<[string, string]> = [
  ['srgb-8bit fixture', 'C:/Foo/raw-converter-wasm/packages/jxl-test-corpus/dist/fixtures/srgb-8bit.jxl'],
  ['P2200619 (real RAW→JXL, prog p6 q85)', 'C:/Foo/raw-converter-wasm/docs/Benchmark results/P2200619-prog-p6-q85.jxl'],
];
const LOADERS: Record<string, () => Promise<never>> = {
  OLD: moduleLoader(OLD_DIR) as never,
  NEW: moduleLoader(NEW_DIR) as never,
  HYB: moduleLoader(HYB_DIR) as never,
};
const ORDER3 = [['OLD', 'NEW', 'HYB'], ['HYB', 'OLD', 'NEW'], ['NEW', 'HYB', 'OLD']];
const BATCHES = 4;
const REPS = 7;

for (const [label, path] of FILES) {
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(readFileSync(path)); } catch (e) { console.log(`SKIP ${label}: ${e}`); continue; }
  const pooled: Record<string, number[]> = { OLD: [], NEW: [], HYB: [] };
  const sums: Record<string, number> = {};
  let dims = '';
  for (let b = 0; b < BATCHES; b++) {
    for (const v of ORDER3[b % ORDER3.length]) {
      setJxlModuleFactoryForTesting(LOADERS[v]);
      await decodeOnce(bytes); // warm
      for (let r = 0; r < REPS; r++) {
        const t0 = performance.now();
        const res = await decodeOnce(bytes);
        pooled[v].push(performance.now() - t0);
        sums[v] = res.sum;
        dims = `${res.w}x${res.h}`;
      }
    }
  }
  setJxlModuleFactoryForTesting(null);
  const mO = median(pooled.OLD), mN = median(pooled.NEW), mH = median(pooled.HYB);
  const pct = (a: number, b: number) => (((a - b) / a) * 100); // >0 means b faster than a
  console.log(`\n=== ${label}  [${dims}, ${bytes.length}B JXL, ${BATCHES}x${REPS} reps] ===`);
  console.log(`  byte-exact: OLD==NEW ${sums.OLD === sums.NEW ? 'Y' : 'N'}  HYB==NEW ${sums.HYB === sums.NEW ? 'Y' : 'N'}  HYB==OLD ${sums.HYB === sums.OLD ? 'Y' : 'N'}`);
  console.log(`  OLD ${mO.toFixed(2)}ms   NEW ${mN.toFixed(2)}ms   ${HYB_LABEL}-reverted ${mH.toFixed(2)}ms`);
  console.log(`  NEW vs OLD:        ${pct(mO, mN) >= 0 ? '' : '+'}${(-pct(mO, mN)).toFixed(1)}%  (regression magnitude, + = NEW slower)`);
  console.log(`  HYBRID vs OLD:     ${pct(mO, mH) >= 0 ? '' : '+'}${(-pct(mO, mH)).toFixed(1)}%  (~0 ⇒ revert fully recovered OLD ⇒ this file IS the culprit)`);
  console.log(`  HYBRID vs NEW:     ${pct(mN, mH) >= 0 ? '-' : '+'}${Math.abs(pct(mN, mH)).toFixed(1)}%  (- = HYBRID faster than NEW ⇒ revert helped)`);
}
