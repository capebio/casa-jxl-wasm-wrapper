import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { performance } from 'node:perf_hooks';

import initRaw, {
  process_cr2_with_flags,
  process_dng_with_flags,
  process_orf_with_flags,
  rgb_to_rgba,
  downscale_rgb
} from '../pkg/raw_converter_wasm.js';
import { Worker as NodeWorker } from 'node:worker_threads';
import { createEncoder, createDecoder, detectTier } from '../packages/jxl-wasm/dist/index.js';

const RAW_ROOT = String.raw`C:\Foo\raw-converter\tests`;
const OUT_DIR = String.raw`C:\Foo\raw-converter-wasm\docs\outputs\timing tests`;
const OUTPUT_FULL_RGB = 1;
const PROCESS_ARGS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Number.NaN, Number.NaN, 0, 0];

const TARGET = 400;
const QUALITY = 80;
const EFFORT = 3;
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-');

class BrowserLikeWorker {
  #worker;
  #onmessage = null;
  #onerror = null;

  constructor(url, options = {}) {
    const workerUrl = url instanceof URL ? url.href : String(url);
    this.#worker = new NodeWorker(new URL('../jxl-worker-shim.mjs', import.meta.url), {
      workerData: {
        url: workerUrl,
        name: options.name ?? '',
      },
    });
    this.#worker.on('message', (data) => {
      this.#onmessage?.({ data });
    });
    this.#worker.on('error', (error) => {
      this.#onerror?.(error);
    });
  }

  postMessage(message, transfer) {
    this.#worker.postMessage(message, transfer);
  }

  terminate() {
    return this.#worker.terminate();
  }

  set onmessage(handler) {
    this.#onmessage = handler;
  }
  get onmessage() {
    return this.#onmessage;
  }
  set onerror(handler) {
    this.#onerror = handler;
  }
  get onerror() {
    return this.#onerror;
  }
}

function exactBuffer(view) {
  if (view instanceof ArrayBuffer) return view;
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view.buffer;
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

function fileType(path) {
  const lower = extname(path).toLowerCase();
  if (lower === '.orf' || lower === '.raw') return 'orf';
  if (lower === '.dng') return 'dng';
  if (lower === '.cr2') return 'cr2';
  throw new Error(`unsupported type: ${path}`);
}

function processRaw(type, bytes) {
  switch (type) {
    case 'orf': return process_orf_with_flags(bytes, OUTPUT_FULL_RGB, ...PROCESS_ARGS);
    case 'dng': return process_dng_with_flags(bytes, OUTPUT_FULL_RGB, ...PROCESS_ARGS);
    case 'cr2': return process_cr2_with_flags(bytes, OUTPUT_FULL_RGB, ...PROCESS_ARGS);
    default: throw new Error(`unsupported type: ${type}`);
  }
}

async function encodeJxl(rgba, width, height) {
  const started = performance.now();
  const encoder = createEncoder({
    format: 'rgba8',
    width,
    height,
    hasAlpha: false,
    distance: 1.0,
    quality: QUALITY,
    effort: EFFORT,
    progressive: true,
    progressiveFlavor: 'ac',
    previewFirst: false,
    chunked: true,
  });
  const chunks = [];
  const chunkTask = (async () => {
    for await (const chunk of encoder.chunks()) {
      chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    }
  })();
  await encoder.pushPixels(exactBuffer(rgba));
  await encoder.finish();
  await chunkTask;
  await encoder.dispose();
  const total = chunks.reduce((s, c) => s + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return { encodeMs: performance.now() - started, jxlBytes: out };
}

async function decodeJxl(jxlBytes) {
  const decoder = createDecoder({
    format: 'rgba8',
    progressionTarget: 'final',
    emitEveryPass: false,
    downsample: 1,
  });
  const t0 = performance.now();
  try {
    const evTask = (async () => {
      for await (const ev of decoder.events()) {
        if (ev.type === 'error') throw new Error(`${ev.code}: ${ev.message}`);
      }
    })();
    await decoder.push(exactBuffer(jxlBytes));
    await decoder.close();
    await evTask;
  } finally {
    try { await decoder.dispose(); } catch (_) {}
  }
  return performance.now() - t0;
}

function toonRunString(run) {
  const lines = [];
  const timeBase = run.records.length ? run.records[0].timestamp.slice(0, 14) : run.timestamp.slice(0, 14);
  lines.push(`TestName: ${run.test}`);
  lines.push(`RunTimestamp: ${run.timestamp}`);
  lines.push(`Agent: ${run.agent}`);
  lines.push(`Tier: ${run.tier}`);
  lines.push(`TimeBase: ${timeBase}`);
  lines.push('');
  lines.push('---');
  lines.push(`runs[${run.records.length}]{t|scenario|files|avg_enc_ms|avg_dec_ms|total_s|mem_peak_mb}:`);
  
  for (const record of run.records) {
    const t = record.timestamp.startsWith(timeBase) ? record.timestamp.slice(timeBase.length).replace(/Z$/, '') : record.timestamp;
    
    const row = [
      t,
      record.scenario,
      record.files,
      formatTiming(record.avg_enc_ms),
      formatTiming(record.avg_dec_ms),
      record.total_s.toFixed(3),
      record.mem_peak_mb.toFixed(2)
    ];
    lines.push(`  ${row.join(' | ')}`);
  }
  if (run.records.length) lines.push('');
  return lines.join('\n') + '\n';
}

function formatTiming(value) { return value === 0 ? '0' : value.toFixed(3); }

async function main() {
  if (typeof globalThis.Worker === 'undefined' && !process.env.JXL_WASM_FORCE_TIER) {
    process.env.JXL_WASM_FORCE_TIER = 'simd';
  }
  if (typeof globalThis.Worker === 'undefined') {
    globalThis.Worker = BrowserLikeWorker;
    globalThis.navigator ??= {};
    globalThis.navigator.hardwareConcurrency ??= 4;
  }
  await initRaw({ module_or_path: readFileSync(new URL('../pkg/raw_converter_wasm_bg.wasm', import.meta.url)) });
  const tier = detectTier();
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  let rawFiles = [];
  if (existsSync(RAW_ROOT)) {
    rawFiles = readdirSync(RAW_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isFile() && ['.orf', '.raw', '.dng', '.cr2'].includes(extname(entry.name).toLowerCase()))
      .map((entry) => join(RAW_ROOT, entry.name));
  } else {
    // Mock if path not accessible
    rawFiles = [
      join(RAW_ROOT, 'P1110226.ORF'),
      join(RAW_ROOT, 'ADH 1234.CR2'),
      join(RAW_ROOT, 'PXL_20260501_093507165.RAW-02.ORIGINAL.dng')
    ];
  }
  // limit to 10 ORFs or duplicate if not enough
  while (rawFiles.length < 10 && rawFiles.length > 0) {
    rawFiles.push(rawFiles[rawFiles.length % 3]);
  }
  rawFiles = rawFiles.slice(0, 10);

  const tStart = performance.now();
  let peakRss = 0;
  
  let totalEncodeMs = 0;
  let totalDecodeMs = 0;
  
  for (let i = 0; i < rawFiles.length; i++) {
    const path = rawFiles[i];
    if (!existsSync(path)) continue;
    const bytes = new Uint8Array(readFileSync(path));
    const type = fileType(path);
    const result = processRaw(type, bytes);
    
    let rgba;
    try {
      const rgb = result.take_rgb();
      const srcW = result.width;
      const srcH = result.height;
      
      const longEdge = Math.max(srcW, srcH);
      const scale = longEdge > TARGET ? TARGET / longEdge : 1;
      const tgtW = Math.round(srcW * scale);
      const tgtH = Math.round(srcH * scale);
      
      rgba = scale < 1
        ? rgb_to_rgba(downscale_rgb(rgb, srcW, srcH, tgtW, tgtH))
        : rgb_to_rgba(rgb);
      
      const { encodeMs, jxlBytes } = await encodeJxl(rgba, tgtW, tgtH);
      totalEncodeMs += encodeMs;
      
      const fullMs = await decodeJxl(jxlBytes);
      totalDecodeMs += fullMs;
      
      const rss = process.memoryUsage().rss;
      if (rss > peakRss) peakRss = rss;
      
    } finally {
      result.free();
    }
  }

  const tEnd = performance.now();
  
  const record = {
    timestamp: new Date().toISOString(),
    scenario: 'Thumb',
    files: rawFiles.length,
    avg_enc_ms: rawFiles.length ? totalEncodeMs / rawFiles.length : 0,
    avg_dec_ms: rawFiles.length ? totalDecodeMs / rawFiles.length : 0,
    total_s: (tEnd - tStart) / 1000,
    mem_peak_mb: peakRss / 1024 / 1024
  };

  const outPath = join(OUT_DIR, `${TIMESTAMP}-test_4_bulk_gallery.toon`);
  writeFileSync(outPath, toonRunString({
    timestamp: TIMESTAMP,
    test: 'bulk-gallery',
    agent: 'Gemini',
    tier,
    records: [record],
  }), 'utf8');
  console.log(`[bulk-gallery] wrote ${basename(outPath)}`);
  process.exit(0);
}

await main();