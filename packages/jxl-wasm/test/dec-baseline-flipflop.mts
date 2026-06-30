// One-off combined dec-path WASM flipflop: OLD dist (pre-integration, built from
// 10783f7e @ b4a55047, extracted from git to C:/Temp/dec-flipflop-old) vs NEW dist
// (current, integrated main 00f4d7fc). No build needed. Batched A/B with start
// rotation to cancel thermal drift; asserts OLD/NEW pixels are byte-identical.
//
//   run from packages/jxl-wasm:  bun test/dec-baseline-flipflop.mts
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createDecoder, setJxlModuleFactoryForTesting } from '../src/index';

const OLD_DIR = 'C:/Temp/dec-flipflop-old';
const distBase = new URL('../dist/', import.meta.url);

function moduleLoader(jsHref: string, locate: (p: string) => string) {
  return async () => {
    const imported = await import(jsHref);
    const factory = imported.default as (cfg: { locateFile: (p: string) => string }) => Promise<unknown>;
    return (await factory({ locateFile: locate })) as never;
  };
}
const loadNEW = moduleLoader(new URL('jxl-core.dec.simd.js', distBase).href, (p) => new URL(p, distBase).href);
const loadOLD = moduleLoader(pathToFileURL(`${OLD_DIR}/jxl-core.dec.simd.js`).href, (p) => pathToFileURL(`${OLD_DIR}/${p}`).href);

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
const trimmedMean = (xs: number[]) => {
  const s = xs.slice().sort((a, b) => a - b);
  const k = Math.floor(s.length * 0.2);
  const t = s.slice(k, s.length - k);
  return t.reduce((a, b) => a + b, 0) / t.length;
};

const FILES: Array<[string, string]> = [
  ['P2200619 (real RAW→JXL, prog p6 q85)', 'C:/Foo/raw-converter-wasm/docs/Benchmark results/P2200619-prog-p6-q85.jxl'],
  ['srgb-8bit fixture', 'C:/Foo/raw-converter-wasm/packages/jxl-test-corpus/dist/fixtures/srgb-8bit.jxl'],
];
const VARIANTS: Record<string, () => Promise<never>> = { OLD: loadOLD as never, NEW: loadNEW as never };
const BATCHES = 4;
const REPS = 12;

for (const [label, path] of FILES) {
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(readFileSync(path)); } catch (e) { console.log(`SKIP ${label}: ${e}`); continue; }
  const pooled: Record<string, number[]> = { OLD: [], NEW: [] };
  const sums: Record<string, number> = {};
  let dims = '';
  for (let b = 0; b < BATCHES; b++) {
    const order = b % 2 === 0 ? ['OLD', 'NEW'] : ['NEW', 'OLD'];
    for (const v of order) {
      setJxlModuleFactoryForTesting(VARIANTS[v]);
      await decodeOnce(bytes); // warm: instantiate + JIT
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
  const mO = median(pooled.OLD), mN = median(pooled.NEW);
  const tO = trimmedMean(pooled.OLD), tN = trimmedMean(pooled.NEW);
  const byteExact = sums.OLD === sums.NEW;
  const deltaMed = ((mO - mN) / mO) * 100;
  const deltaTrim = ((tO - tN) / tO) * 100;
  console.log(`\n=== ${label}  [${dims}, ${bytes.length}B JXL, ${BATCHES}x${REPS} reps/variant] ===`);
  console.log(`  byte-exact OLD==NEW pixels: ${byteExact ? 'YES' : 'NO (!!)'}  (sum O=${sums.OLD} N=${sums.NEW})`);
  console.log(`  OLD median ${mO.toFixed(2)}ms  trim ${tO.toFixed(2)}ms`);
  console.log(`  NEW median ${mN.toFixed(2)}ms  trim ${tN.toFixed(2)}ms`);
  console.log(`  NEW vs OLD: median ${deltaMed >= 0 ? '-' : '+'}${Math.abs(deltaMed).toFixed(1)}%  trim ${deltaTrim >= 0 ? '-' : '+'}${Math.abs(deltaTrim).toFixed(1)}%  (negative = NEW slower)`);
}
