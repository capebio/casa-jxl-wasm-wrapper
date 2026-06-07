import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { Worker as NodeWorker } from 'node:worker_threads';

class BrowserLikeWorker {
  #worker;
  #onmessage = null;
  #onerror = null;

  constructor(url, options = {}) {
    const workerUrl = url instanceof URL ? url.href : String(url);
    this.#worker = new NodeWorker(new URL('../jxl-worker-shim.mjs', import.meta.url), {
      workerData: { url: workerUrl, name: options.name ?? '' },
    });
    this.#worker.on('message', (data) => this.#onmessage?.({ data }));
    this.#worker.on('error', (error) => this.#onerror?.(error));
  }

  postMessage(message, transfer) { this.#worker.postMessage(message, transfer); }
  terminate() { return this.#worker.terminate(); }
  set onmessage(handler) { this.#onmessage = handler; }
  get onmessage() { return this.#onmessage; }
  set onerror(handler) { this.#onerror = handler; }
  get onerror() { return this.#onerror; }
}

globalThis.Worker = BrowserLikeWorker;

import initRaw, {
  downscale_rgb,
  process_orf_with_flags,
  process_cr2_with_flags,
  process_dng_with_flags,
  rgb_to_rgba,
} from "../pkg/raw_converter_wasm.js";

if (typeof globalThis.Worker === "undefined" && !process.env.JXL_WASM_FORCE_TIER) {
  process.env.JXL_WASM_FORCE_TIER = "simd";
}
const { createDecoder, createEncoder, detectTier } = await import("../packages/jxl-wasm/dist/index.js");

await initRaw({ module_or_path: readFileSync(new URL("../pkg/raw_converter_wasm_bg.wasm", import.meta.url)) });

const TEST_ROOT = String.raw`C:\Foo\raw-converter\tests`;
const BASE_FILES = [
  join(TEST_ROOT, 'P1110226.ORF'),
  join(TEST_ROOT, 'ADH 1234.CR2'),
  join(TEST_ROOT, 'PXL_20260501_093507165.RAW-02.ORIGINAL.dng'),
];
// Repeat each file so there are at least 3 runs per format
const FILES = [];
for (const file of BASE_FILES) {
  FILES.push(file);
  FILES.push(file);
  FILES.push(file);
}

const TARGET = 1920;
const OUTPUT_FULL_RGB = 1;
const PROCESS_ARGS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Number.NaN, Number.NaN, 0, 0];

const OUT_DIR = String.raw`C:\Foo\raw-converter-wasm\docs\outputs\timing tests`;
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

function exactBuffer(view) {
  if (view instanceof ArrayBuffer) return view;
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view.buffer;
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

function concatChunks(chunks) {
  const total = chunks.reduce((s, c) => s + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

async function encodeJxl(rgba, width, height, isProgressive) {
  const encoder = createEncoder({
    format: 'rgba8', width, height, hasAlpha: false,
    iccProfile: null, exif: null, xmp: null,
    distance: 1.0, quality: 85, effort: 3,
    progressive: isProgressive, progressiveFlavor: 'ac', previewFirst: false,
    chunked: true,
  });
  const chunks = [];
  const chunkTask = (async () => {
    for await (const chunk of encoder.chunks())
      chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
  })();
  const t0 = performance.now();
  await encoder.pushPixels(exactBuffer(rgba));
  await encoder.finish();
  await chunkTask;
  await encoder.dispose();
  const ms = performance.now() - t0;
  return { bytes: concatChunks(chunks), ms };
}

async function decodeJxl(jxlBytes, isProgressive, options = {}) {
  const decoder = createDecoder({
    format: 'rgba8',
    progressionTarget: options.progressionTarget ?? 'final',
    emitEveryPass: options.emitEveryPass ?? isProgressive,
    progressiveDetail: options.progressiveDetail ?? (isProgressive ? 'passes' : 'none'),
    downsample: options.downsample ?? 1,
    region: options.region,
    preserveIcc: false, preserveMetadata: false,
  });
  let passCount = 0;
  let firstFrameMs = null;
  const t0 = performance.now();
  try {
    const evTask = (async () => {
      for await (const ev of decoder.events()) {
        if (ev.type === 'progress' || ev.type === 'final') {
          passCount++;
          if (firstFrameMs === null) firstFrameMs = performance.now() - t0;
        }
        else if (ev.type === 'error') throw new Error(`${ev.code}: ${ev.message}`);
      }
    })();
    await decoder.push(exactBuffer(jxlBytes));
    await decoder.close();
    await evTask;
  } finally {
    try { await decoder.dispose(); } catch (_) {}
  }
  const ms = performance.now() - t0;
  return { ms, firstFrameMs: firstFrameMs ?? ms, passCount };
}

async function runTest() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const isoStamp = new Date().toISOString();
  const toonLines = [
    `TestName: progressive vs 1-shot (Test_1)`,
    `RunTimestamp: ${isoStamp}`,
    `Target: ${TARGET}`,
    `Notes: Compare rich decode timings (full, ds2, region, etc) for progressive vs 1-shot encoding, 3 iterations per file.`,
  ];

  let progEncodeSum = 0, oneshotEncodeSum = 0;
  let progFullSum = 0, progFirstFrameSum = 0, progDs2Sum = 0, progRegionSum = 0, progRegionDs2Sum = 0, progDcDs2Sum = 0;
  let oneshotFullSum = 0, oneshotDs2Sum = 0, oneshotRegionSum = 0, oneshotRegionDs2Sum = 0;

  const progResults = [];
  const oneshotResults = [];

  for (let i = 0; i < FILES.length; i++) {
    const filePath = FILES[i];
    if (!existsSync(filePath)) {
      console.warn(`File not found: ${filePath}`);
      continue;
    }
    const ext = extname(filePath).toLowerCase();
    const raw = new Uint8Array(readFileSync(filePath));
    let decoded;
    if (ext === '.orf' || ext === '.raw') decoded = process_orf_with_flags(raw, OUTPUT_FULL_RGB, ...PROCESS_ARGS);
    else if (ext === '.cr2') decoded = process_cr2_with_flags(raw, OUTPUT_FULL_RGB, ...PROCESS_ARGS);
    else if (ext === '.dng') decoded = process_dng_with_flags(raw, OUTPUT_FULL_RGB, ...PROCESS_ARGS);
    else throw new Error("Unknown ext: " + ext);

    const rgb = decoded.take_rgb();
    const srcW = decoded.width;
    const srcH = decoded.height;
    decoded.free();

    const longEdge = Math.max(srcW, srcH);
    const scale = longEdge > TARGET ? TARGET / longEdge : 1;
    const tgtW = Math.round(srcW * scale);
    const tgtH = Math.round(srcH * scale);
    const rgba = scale < 1
      ? rgb_to_rgba(downscale_rgb(rgb, srcW, srcH, tgtW, tgtH))
      : rgb_to_rgba(rgb);

    const regionCenter50 = {
      x: Math.floor(tgtW * 0.25),
      y: Math.floor(tgtH * 0.25),
      w: Math.floor(tgtW * 0.5),
      h: Math.floor(tgtH * 0.5),
    };

    console.log(`Testing [${i+1}/${FILES.length}] ${basename(filePath)} (${tgtW}x${tgtH})...`);

    // Progressive
    const progEncode = await encodeJxl(rgba, tgtW, tgtH, true);
    const progFull = await decodeJxl(progEncode.bytes, true);
    const progDcDs2 = await decodeJxl(progEncode.bytes, true, { emitEveryPass: false, progressiveDetail: 'dc', downsample: 2 });
    const progDs2 = await decodeJxl(progEncode.bytes, true, { emitEveryPass: false, downsample: 2 });
    const progRegion = await decodeJxl(progEncode.bytes, true, { emitEveryPass: false, downsample: 1, region: regionCenter50 });
    const progRegionDs2 = await decodeJxl(progEncode.bytes, true, { emitEveryPass: false, downsample: 2, region: regionCenter50 });

    // One-shot
    const oneShotEncode = await encodeJxl(rgba, tgtW, tgtH, false);
    const oneshotFull = await decodeJxl(oneShotEncode.bytes, false);
    const oneshotDs2 = await decodeJxl(oneShotEncode.bytes, false, { downsample: 2 });
    const oneshotRegion = await decodeJxl(oneShotEncode.bytes, false, { downsample: 1, region: regionCenter50 });
    const oneshotRegionDs2 = await decodeJxl(oneShotEncode.bytes, false, { downsample: 2, region: regionCenter50 });

    progEncodeSum += progEncode.ms;
    progFullSum += progFull.ms;
    progFirstFrameSum += progFull.firstFrameMs;
    progDs2Sum += progDs2.ms;
    progRegionSum += progRegion.ms;
    progRegionDs2Sum += progRegionDs2.ms;
    progDcDs2Sum += progDcDs2.ms;

    oneshotEncodeSum += oneShotEncode.ms;
    oneshotFullSum += oneshotFull.ms;
    oneshotDs2Sum += oneshotDs2.ms;
    oneshotRegionSum += oneshotRegion.ms;
    oneshotRegionDs2Sum += oneshotRegionDs2.ms;

    progResults.push(`  ${basename(filePath)},${i+1},${progEncode.ms.toFixed(3)},${progFull.firstFrameMs.toFixed(3)},${progFull.ms.toFixed(3)},${progDcDs2.ms.toFixed(3)},${progDs2.ms.toFixed(3)},${progRegion.ms.toFixed(3)},${progRegionDs2.ms.toFixed(3)},${progFull.passCount},${progEncode.bytes.byteLength}`);
    oneshotResults.push(`  ${basename(filePath)},${i+1},${oneShotEncode.ms.toFixed(3)},${oneshotFull.ms.toFixed(3)},${oneshotDs2.ms.toFixed(3)},${oneshotRegion.ms.toFixed(3)},${oneshotRegionDs2.ms.toFixed(3)},${oneShotEncode.bytes.byteLength}`);
    
    console.log(`  Prog: enc=${Math.round(progEncode.ms)}ms first=${Math.round(progFull.firstFrameMs)}ms final=${Math.round(progFull.ms)}ms dc_ds2=${Math.round(progDcDs2.ms)}ms ds2=${Math.round(progDs2.ms)}ms reg=${Math.round(progRegion.ms)}ms reg_ds2=${Math.round(progRegionDs2.ms)}ms`);
    console.log(`  1-Shot: enc=${Math.round(oneShotEncode.ms)}ms final=${Math.round(oneshotFull.ms)}ms ds2=${Math.round(oneshotDs2.ms)}ms reg=${Math.round(oneshotRegion.ms)}ms reg_ds2=${Math.round(oneshotRegionDs2.ms)}ms`);
  }

  // Permutation 1: Progressive
  toonLines.push("");
  toonLines.push("---");
  toonLines.push(`Permutation: effort=3, quality=85, target=${TARGET}px, type=progressive`);
  toonLines.push(`Timestamp: ${isoStamp}`);
  toonLines.push(`rows[1]{file,iter,encode_ms,decode_first_paint_ms,decode_final_ms,decode_dc_ds2_ms,decode_ds2_ms,decode_region_ms,decode_region_ds2_ms,passes,size_bytes}:`);
  toonLines.push(...progResults);

  // Permutation 2: One-shot
  toonLines.push("");
  toonLines.push("---");
  toonLines.push(`Permutation: effort=3, quality=85, target=${TARGET}px, type=oneshot`);
  toonLines.push(`Timestamp: ${isoStamp}`);
  toonLines.push(`rows[1]{file,iter,encode_ms,decode_final_ms,decode_ds2_ms,decode_region_ms,decode_region_ds2_ms,size_bytes}:`);
  toonLines.push(...oneshotResults);

  const toonPath = join(OUT_DIR, `${stamp}-test_1_progressive_vs_oneshot.toon`);
  writeFileSync(toonPath, toonLines.join("\n"));
  console.log(`\nWritten results to ${toonPath}`);
}

runTest().then(() => process.exit(0)).catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
