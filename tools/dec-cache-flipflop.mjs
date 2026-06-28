// dec-cache-flipflop.mjs — byte-exact + interleaved A/B timing/memory harness for
// the dec_cache optimizations (scratch arena aliasing, num_nzeroes uint8,
// used_acs snapshot, sigma reuse, cross-frame GroupDecCache retention).
//
// Loads two *decoder* wasm builds — OLD (baseline) and NEW (with the opts) —
// decodes a shared .jxl corpus through the real facade -> bridge -> wasm path,
// then:
//   1. SHA256-compares the decoded pixels per file  (byte-exact GATE)
//   2. times OLD vs NEW interleaved with start-rotation (flipflop anti-drift)
//   3. records peak wasm heap (HEAPU8.length) per build  (the memory win)
//
// Usage:
//   bun tools/dec-cache-flipflop.mjs <old.dec.js> <new.dec.js> [reps]
//
// The two .js paths must sit next to their .wasm siblings (emscripten locateFile).

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createDecoder, setJxlModuleFactoryForTesting } from '../packages/jxl-wasm/src/index.ts';

const [, , oldJs, newJs, repsArg] = process.argv;
const reps = Number(repsArg ?? 12);
if (!oldJs || !newJs) {
  console.error('usage: bun tools/dec-cache-flipflop.mjs <old.dec.js> <new.dec.js> [reps]');
  process.exit(2);
}

const TMP = process.env.TEMP ?? process.env.TMP ?? '/tmp';
const repoRoot = new URL('..', import.meta.url);

// Diverse corpus: 444 + subsampling + alpha + 16-bit + grayscale + splines +
// blending (multi-frame, exercises sigma reuse + cross-frame cache retention) +
// multipass (exercises num_nzeroes prediction across passes) + JPEG recon.
const CANDIDATES = [
  // curated fixtures
  ['packages/jxl-test-corpus/dist/fixtures/srgb-8bit.jxl', 'rgba8'],
  ['packages/jxl-test-corpus/dist/fixtures/srgb-alpha-8bit.jxl', 'rgba8'],
  ['packages/jxl-test-corpus/dist/fixtures/adobe-rgb-16bit.jxl', 'rgba16'],
  ['packages/jxl-test-corpus/dist/fixtures/gray-ramp-16bit.jxl', 'rgba16'],
  ['packages/jxl-test-corpus/dist/fixtures/lossless-16bit.jxl', 'rgba16'],
  ['packages/jxl-test-corpus/dist/fixtures/saturated-green-16bit.jxl', 'rgba16'],
  // libjxl testdata — varblocks / splines / multi-frame blending / jpeg recon
  ['external/libjxl-012/testdata/jxl/splines.jxl', 'rgba8'],
  ['external/libjxl-012/testdata/jxl/blending/cropped_traffic_light.jxl', 'rgba8'],
  ['external/libjxl-012/testdata/jxl/pq_gradient.jxl', 'rgba16'],
  ['external/libjxl-012/testdata/jxl/jpeg_reconstruction/1x1_exif_xmp.jxl', 'rgba8'],
];
// absolute multipass files in TEMP (exercise multi-pass nzeros prediction)
const TEMP_FILES = [
  ['mp_ac_only.jxl', 'rgba8'],
  ['mp_qac_only.jxl', 'rgba8'],
  ['mp_ac_qac_dc2.jxl', 'rgba8'],
  ['alpha_multipass.jxl', 'rgba8'],
  ['test_multipass.jxl', 'rgba8'],
];

function buildCorpus() {
  const out = [];
  for (const [rel, fmt] of CANDIDATES) {
    const p = new URL(rel, repoRoot);
    if (existsSync(p)) out.push({ name: rel, bytes: new Uint8Array(readFileSync(p)), fmt });
  }
  for (const [f, fmt] of TEMP_FILES) {
    const p = `${TMP}\\${f}`;
    if (existsSync(p)) out.push({ name: f, bytes: new Uint8Array(readFileSync(p)), fmt });
  }
  return out;
}

async function loadModule(jsPath) {
  // The emscripten .js hardcodes the base wasm name (jxl-core.dec.simd.wasm),
  // but our OLD/NEW copies sit beside the .js with matching suffixes. Force
  // locateFile to the sibling wasm derived from THIS js path, so OLD.js loads
  // OLD.wasm and NEW.js loads NEW.wasm regardless of the embedded name.
  const url = new URL(jsPath, `file://${process.cwd().replace(/\\/g, '/')}/`);
  const factory = (await import(url.href)).default;
  const wasmHref = new URL(jsPath.replace(/\.js$/, '.wasm'),
                           `file://${process.cwd().replace(/\\/g, '/')}/`).href;
  return factory({ locateFile: (p) => (p.endsWith('.wasm') ? wasmHref : p) });
}

async function decodeToPixels(module, item) {
  setJxlModuleFactoryForTesting(async () => module);
  const dec = createDecoder({
    format: item.fmt, region: null, downsample: 1,
    progressionTarget: 'final', emitEveryPass: false,
    progressiveDetail: 'frames', preserveIcc: false, preserveMetadata: false,
  });
  dec.push(item.bytes); dec.close();
  let pixels = null, w = 0, h = 0;
  for await (const ev of dec.events()) {
    if (ev.type === 'final') {
      pixels = ev.pixels instanceof Uint8Array ? ev.pixels : new Uint8Array(ev.pixels);
      w = ev.width ?? w; h = ev.height ?? h;
    } else if (ev.type === 'error') {
      throw new Error(`${item.name}: ${ev.message}`);
    }
  }
  try { await dec.dispose(); } catch {}
  return { pixels, w, h };
}

const sha = (u8) => createHash('sha256').update(u8).digest('hex');
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

async function main() {
  const corpus = buildCorpus();
  if (corpus.length === 0) { console.error('empty corpus'); process.exit(2); }
  console.log(`corpus: ${corpus.length} files, reps=${reps}\n`);

  const oldMod = await loadModule(oldJs);
  const newMod = await loadModule(newJs);

  // ---- 1. byte-exact gate ----
  let allExact = true;
  const peak = { OLD: 0, NEW: 0 };
  console.log('byte-exact (OLD vs NEW decoded pixels):');
  for (const item of corpus) {
    const a = await decodeToPixels(oldMod, item);
    const b = await decodeToPixels(newMod, item);
    peak.OLD = Math.max(peak.OLD, oldMod.HEAPU8.length);
    peak.NEW = Math.max(peak.NEW, newMod.HEAPU8.length);
    const ha = sha(a.pixels), hb = sha(b.pixels);
    const ok = ha === hb && a.pixels.length === b.pixels.length;
    allExact &&= ok;
    console.log(`  ${ok ? 'OK  ' : 'DIFF'} ${item.name}  ${a.w}x${a.h}  ${a.pixels.length}B  ${ha.slice(0, 12)}`);
  }
  console.log(`\nbyte-exact: ${allExact ? 'PASS (all identical)' : 'FAIL'}`);
  console.log(`peak HEAPU8: OLD=${(peak.OLD / 1048576).toFixed(2)}MiB  NEW=${(peak.NEW / 1048576).toFixed(2)}MiB\n`);

  // ---- 2. interleaved A/B timing with start-rotation (flipflop) ----
  const t = { OLD: [], NEW: [] };
  for (let r = 0; r < reps; r++) {
    const order = r % 2 === 0 ? [['OLD', oldMod], ['NEW', newMod]] : [['NEW', newMod], ['OLD', oldMod]];
    for (const [label, mod] of order) {
      const s = performance.now();
      for (const item of corpus) await decodeToPixels(mod, item);
      t[label].push(performance.now() - s);
    }
  }
  const mo = median(t.OLD), mn = median(t.NEW);
  console.log('timing (full-corpus decode, median of reps):');
  console.log(`  OLD ${mo.toFixed(2)}ms   NEW ${mn.toFixed(2)}ms   delta ${(((mo - mn) / mo) * 100).toFixed(2)}% ${mn < mo ? 'faster' : 'slower'}`);

  process.exit(allExact ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
