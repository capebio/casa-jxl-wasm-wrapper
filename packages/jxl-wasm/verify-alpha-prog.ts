// Decode-only verification of the allowAlphaProgressive flag.
// Decodes an alpha VarDCT JXL twice (flag off vs on) and counts progressive
// paint events. Expectation: off => guard suppresses intermediate paints (~0-1);
// on => multiple intermediate paints. Run with bun:
//   bun verify-alpha-prog.ts "../../docs/Benchmark results/P2200619-prog-p6-q85.jxl"
import { readFileSync } from 'node:fs';
import { createDecoder, setJxlModuleFactoryForTesting } from './src/index';

const MOD = process.env.JXL_MOD ?? './dist/jxl-core.dec.simd.js';

async function factory() {
  const imported = await import(MOD);
  const f = imported.default as (cfg: { locateFile: (p: string) => string }) => Promise<unknown>;
  const baseUrl = new URL('./dist/', import.meta.url);
  return (await f({ locateFile: (p: string) => new URL(p, baseUrl).href })) as never;
}

async function countPaints(bytes: Uint8Array, allowAlphaProgressive: boolean) {
  const decoder = createDecoder({
    format: 'rgba8',
    region: null,
    downsample: 1,
    progressionTarget: 'final',
    emitEveryPass: true,
    progressiveDetail: 'passes',
    allowAlphaProgressive,
    preserveIcc: false,
    preserveMetadata: false,
  });
  let progress = 0;
  let final = false;
  let err: string | null = null;
  let info: unknown = null;
  const task = (async () => {
    for await (const ev of decoder.events()) {
      if (ev.type === 'error') err = ev.message;
      else if (ev.type === 'header') info = ev.info;
      else if (ev.type === 'progress') progress++;
      else if (ev.type === 'final') final = true;
    }
  })();
  const chunk = 16384;
  for (let o = 0; o < bytes.byteLength; o += chunk) {
    decoder.push(bytes.subarray(o, Math.min(bytes.byteLength, o + chunk)));
    await new Promise((r) => setTimeout(r, 0));
  }
  decoder.close();
  await task;
  await decoder.dispose();
  return { progress, final, err, info };
}

const path = process.argv[2];
if (!path) throw new Error('usage: bun verify-alpha-prog.ts <file.jxl>');
const bytes = new Uint8Array(readFileSync(path));
setJxlModuleFactoryForTesting(factory);
console.log('module :', MOD);
console.log('file   :', path, `(${bytes.byteLength} bytes)`);
const off = await countPaints(bytes, false);
console.log('flag=OFF:', JSON.stringify(off));
const on = await countPaints(bytes, true);
console.log('flag=ON :', JSON.stringify(on));
console.log(on.progress > off.progress
  ? `PASS: flag enables ${on.progress - off.progress} extra progressive paints (off=${off.progress} on=${on.progress})`
  : `INCONCLUSIVE: off=${off.progress} on=${on.progress} (no delta)`);
