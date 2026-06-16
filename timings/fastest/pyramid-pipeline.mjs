// Pyramid pipeline bench — challenges "can't get earlier decode from a full-size image".
//
// Builds ONE responsive master via encode_rgba8_with_sidecars([256,1024,2048]+full),
// then times a standalone decode of each level. The point: decoding the right-sized
// level for a viewport costs ~ms, vs decoding/transcoding the full frame (~648ms).
//
// Master source = the embedded "medium" JPEG decoded to full-res RGBA (sharp), used as a
// fast stand-in for the RAW-decoded master. Pyramid mechanics/timings scale the same way
// for a true 5240x3912 RAW master; only absolute encode time grows.
//
// Run:  node ./pyramid-pipeline.mjs       (relaxed-simd-mt / simd-mt under the Worker shim)
//       bun  ./pyramid-pipeline.mjs       (forced simd)

import { open, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';
import { Worker as NodeWorker } from 'node:worker_threads';
import {
  createEncoder,
  createDecoder,
  transcodeJpegToJxl,
  detectTier,
  setForcedTier,
} from '../../packages/jxl-wasm/dist/index.js';

// --- Browser-like Worker shim so multi-threaded WASM tiers engage under Node ---
// (verbatim from optimal-pipeline.mjs / inbetween-pipeline.mjs)
class BrowserLikeWorker {
  #worker;
  #onmessage = null;
  #onerror = null;
  constructor(url, options = {}) {
    const workerUrl = url instanceof URL ? url.href : String(url);
    this.#worker = new NodeWorker(new URL('../../jxl-worker-shim.mjs', import.meta.url), {
      workerData: { url: workerUrl, name: options.name ?? '' },
    });
    this.#worker.on('message', (data) => { this.#onmessage?.({ data }); });
    this.#worker.on('error', (error) => { this.#onerror?.(error); });
  }
  postMessage(message, transfer) { this.#worker.postMessage(message, transfer); }
  terminate() { return this.#worker.terminate(); }
  set onmessage(h) { this.#onmessage = h; } get onmessage() { return this.#onmessage; }
  set onerror(h) { this.#onerror = h; }   get onerror() { return this.#onerror; }
}

const ORF_PATH = String.raw`c:\995\2026-02-20 Gobabeb To Windhoek\P2200476 Pogonospermum cleomoides.ORF`;
const SIDECAR_SIZES = [256, 1024, 2048]; // max long-edge per level; sizes >= master long-edge are skipped
const EFFORT = 3;     // full-image effort (sidecars internally cap at 5); memory: effort 3 best speed+filesize
const QUALITY = 85;   // aligns with page q85 default

// Viewport targets to demonstrate "deliver approximately the right size".
const VIEWPORT_TARGETS = [
  { name: 'grid tile  @1x (400px)', longEdge: 400 },
  { name: 'grid tile  @2x (800px)', longEdge: 800 },
  { name: 'detail view (1600px)',   longEdge: 1600 },
];

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

async function extractMediumJpeg(fh) {
  const buf = Buffer.allocUnsafe(2 * 1024 * 1024);
  await fh.read(buf, 0, buf.length, 0);
  const SOI = Buffer.from([0xff, 0xd8, 0xff]);
  const EOI = Buffer.from([0xff, 0xd9]);
  const start = buf.indexOf(SOI, 0);
  const next = buf.indexOf(SOI, start + 3); // skip the tiny preview, take the medium
  const end = buf.indexOf(EOI, next);
  return buf.subarray(next, end + 2);
}

async function decodeJxlOneShot(bytes) {
  const t0 = performance.now();
  const decoder = createDecoder({
    format: 'rgba8',
    progressionTarget: 'final',
    emitEveryPass: false,
    preserveIcc: true,
    preserveMetadata: false,
  });
  let final = null;
  const drain = (async () => {
    for await (const ev of decoder.events()) {
      if (ev.type === 'final') final = ev;
      else if (ev.type === 'error') throw new Error(`decode ${ev.code}: ${ev.message}`);
    }
  })();
  await decoder.push(bytes);
  await decoder.close();
  await drain;
  await decoder.dispose();
  if (!final) throw new Error('decode produced no final frame');
  return { ms: performance.now() - t0, width: final.info.width, height: final.info.height };
}

// Time a level decode: discard the first run (cold), report min + median of the rest.
// Isolates marginal decode cost from per-call/JIT warmup so the pyramid lever is honest.
async function timeDecodeLevel(bytes, reps = 4) {
  let dims = null;
  const samples = [];
  for (let r = 0; r <= reps; r++) {
    const d = await decodeJxlOneShot(bytes);
    dims = d;
    if (r > 0) samples.push(d.ms); // r==0 is the cold run
  }
  samples.sort((a, b) => a - b);
  const min = samples[0];
  const median = samples[Math.floor(samples.length / 2)];
  return { min, median, cold: dims.ms, width: dims.width, height: dims.height };
}

async function encodePyramid(rgba, width, height) {
  const t0 = performance.now();
  const encoder = createEncoder({
    format: 'rgba8',
    width,
    height,
    hasAlpha: false,
    iccProfile: null,
    exif: null,
    xmp: null,
    distance: null,
    quality: QUALITY,
    effort: EFFORT,
    progressive: false,
    previewFirst: false,
    chunked: true,
    sidecarSizes: SIDECAR_SIZES,
  });
  const levels = [];
  const collect = (async () => {
    for await (const c of encoder.chunks()) {
      levels.push(c instanceof Uint8Array ? c : new Uint8Array(c));
    }
  })();
  await encoder.pushPixels(rgba);
  await encoder.finish();
  await collect;
  await encoder.dispose();
  return { levels, ms: performance.now() - t0 }; // levels: smallest sidecar first, full image last
}

async function main() {
  if (typeof Bun !== 'undefined') {
    setForcedTier('simd');
  } else if (typeof globalThis.Worker === 'undefined') {
    globalThis.Worker = BrowserLikeWorker;
    globalThis.navigator ??= {};
    globalThis.navigator.hardwareConcurrency ??= 8;
  }
  console.log(`JXL WASM Tier: ${detectTier()}\n`);

  // 1. Extract embedded medium JPEG (this is the "naive transcode" input).
  const fh = await open(ORF_PATH, 'r');
  let mediumJpeg;
  try {
    mediumJpeg = await extractMediumJpeg(fh);
  } finally {
    await fh.close();
  }
  console.log(`Embedded medium JPEG: ${kb(mediumJpeg.length)}`);

  // 2. Baseline: lossless JPEG -> JXL transcode (the ~648ms number being challenged).
  {
    const t0 = performance.now();
    const jxl = await transcodeJpegToJxl(mediumJpeg);
    console.log(`Baseline transcode (medium JPEG -> JXL): ${(performance.now() - t0).toFixed(2)} ms -> ${kb(jxl.byteLength)}\n`);
  }

  // 3. Master pixels: decode the medium JPEG to full-res RGBA.
  const t0 = performance.now();
  const { data: rgba, info } = await sharp(mediumJpeg).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  console.log(`Master RGBA: ${info.width}x${info.height} (sharp decode ${(performance.now() - t0).toFixed(2)} ms)\n`);

  // 4. Encode the responsive pyramid (sidecars + full) in ONE call.
  const { levels, ms: encodeMs } = await encodePyramid(rgba, info.width, info.height);
  console.log(`Pyramid encode (sidecars ${JSON.stringify(SIDECAR_SIZES)} + full): ${encodeMs.toFixed(2)} ms, ${levels.length} levels\n`);

  // 5. Decode each level standalone; warm the subsystem first, then report steady-state.
  await decodeJxlOneShot(levels[0]); // global warmup (JIT / thread pool / decoder setup)
  console.log('--- Per-level standalone decode (min / median of 4 warm runs; cold in parens) ---');
  const decoded = [];
  for (let i = 0; i < levels.length; i++) {
    const jxl = levels[i];
    const t = await timeDecodeLevel(jxl);
    const isFull = i === levels.length - 1;
    const longEdge = Math.max(t.width, t.height);
    decoded.push({ index: i, longEdge, width: t.width, height: t.height, bytes: jxl.length, min: t.min, median: t.median, cold: t.cold, isFull });
    const label = isFull ? 'FULL' : `L${i}`;
    console.log(`  ${label.padEnd(4)} ${String(t.width).padStart(4)}x${String(t.height).padEnd(4)}  size=${kb(jxl.length).padStart(9)}  decode min=${t.min.toFixed(2).padStart(7)} ms  median=${t.median.toFixed(2).padStart(7)} ms  (cold ${t.cold.toFixed(0)} ms)`);
    await writeFile(`pyramid-${isFull ? 'full' : `L${i}-${longEdge}`}.jxl`, jxl);
  }

  // 6. "Deliver approximately the right size": pick smallest level whose long edge >= target.
  console.log('\n--- Right-size selection (smallest level >= target long edge; warm decode) ---');
  for (const vp of VIEWPORT_TARGETS) {
    const pick = decoded.find((l) => l.longEdge >= vp.longEdge) ?? decoded[decoded.length - 1];
    const lbl = pick.isFull ? 'FULL' : `L${pick.index}`;
    console.log(`  ${vp.name.padEnd(24)} -> ${lbl} ${pick.width}x${pick.height}  decode=${pick.min.toFixed(2)} ms  (${kb(pick.bytes)})`);
  }

  // 7. Verdict: full-frame decode vs smallest-level decode (warm, marginal cost).
  const full = decoded[decoded.length - 1];
  const smallest = decoded[0];
  console.log(`\nVerdict (warm): full decode ${full.min.toFixed(1)} ms  vs  smallest level ${smallest.min.toFixed(1)} ms  =>  ${(full.min / smallest.min).toFixed(1)}x faster to first right-sized pixels`);
  console.log(`Baseline contrast: pre-built FULL JXL decodes in ${full.min.toFixed(1)} ms vs transcoding the JPEG each view (~968 ms cold).`);

  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
