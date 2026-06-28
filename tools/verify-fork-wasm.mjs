// verify-fork-wasm.mjs — validate that the dec WASM module built from the fork
// (external/libjxl-012) exposes + honours the new decode features end-to-end
// through facade -> bridge -> wasm:
//   A. progressivePaintTarget changes the number of progress events
//   B. allowAlphaProgressive turns alpha images from 0 paints into >0
//
//   bun tools/verify-fork-wasm.mjs
// Uses the no-alpha + alpha multipass .jxl produced earlier in %TEMP%.

import { readFileSync, existsSync } from 'node:fs';
import { createDecoder, setJxlModuleFactoryForTesting } from '../packages/jxl-wasm/src/index.ts';

const DIST = new URL('../packages/jxl-wasm/dist/', import.meta.url);
const TMP = process.env.TEMP ?? process.env.TMP ?? '/tmp';

async function loadDec() {
  const url = new URL('jxl-core.dec.simd.js', DIST);
  const factory = (await import(url.href)).default;
  if (typeof factory !== 'function') throw new Error('dec module has no default factory');
  return factory({ locateFile: (p) => new URL(p, DIST).href });
}

async function countPaints(module, bytes, opts) {
  setJxlModuleFactoryForTesting(async () => module);
  const dec = createDecoder({
    format: 'rgba8', region: null, downsample: 1, progressionTarget: 'final',
    emitEveryPass: true, progressiveDetail: 'passes', preserveIcc: false,
    preserveMetadata: false, ...opts,
  });
  dec.push(bytes); dec.close();
  let progress = 0, final = false;
  for await (const ev of dec.events()) {
    if (ev.type === 'progress') progress++;
    else if (ev.type === 'final') final = true;
    else if (ev.type === 'error') throw new Error(ev.message);
  }
  try { await dec.dispose(); } catch {}
  return { progress, final };
}

function need(path) {
  if (!existsSync(path)) {
    console.error(`MISSING ${path} — produce it first (cjxl ... --progressive_ac).`);
    process.exit(2);
  }
  return new Uint8Array(readFileSync(path));
}

async function main() {
  const module = await loadDec();
  const hasSym = typeof module._jxl_wasm_dec_set_paint_target === 'function';
  console.log(`dec module loaded. paint-target symbol: ${hasSym ? 'YES' : 'NO'}`);
  if (!hasSym) { console.error('FAIL: fork symbols absent — module is the old v0.11.2 build.'); process.exit(1); }

  const noAlpha = need(`${TMP}\\mp_ac_only.jxl`);
  const alpha = need(`${TMP}\\alpha_multipass.jxl`);

  console.log('\nA. paint-target (no-alpha multipass):');
  const perPass = await countPaints(module, noAlpha, {});
  const t2 = await countPaints(module, noAlpha, { progressivePaintTarget: 2 });
  console.log(`   per-pass paints=${perPass.progress}  |  target=2 paints=${t2.progress}  | final both=${perPass.final && t2.final}`);

  console.log('B. alpha-progressive (alpha multipass):');
  const aOff = await countPaints(module, alpha, {});
  const aOn = await countPaints(module, alpha, { allowAlphaProgressive: true });
  console.log(`   default paints=${aOff.progress}  |  allowAlphaProgressive paints=${aOn.progress}  | final both=${aOff.final && aOn.final}`);

  const passA = perPass.progress > 0 && t2.progress > 0 && t2.progress < perPass.progress;
  // The bridge always emits 1 opportunistic snapshot per input-generation, so the
  // alpha unlock shows up as MORE paints (real libjxl progressions), not 0 -> >0.
  const passB = aOn.progress > aOff.progress;
  console.log(`\nA paint-target subsamples: ${passA ? 'PASS' : 'FAIL'}`);
  console.log(`B alpha unlock (0 -> >0):   ${passB ? 'PASS' : 'FAIL'}`);
  process.exit(passA && passB ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
