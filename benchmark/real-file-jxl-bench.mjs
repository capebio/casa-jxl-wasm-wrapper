import { readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Worker as NodeWorker } from 'node:worker_threads';

const TEST_ROOT = 'C:/Foo/raw-converter/tests';
const FILES = [
  join(TEST_ROOT, 'P1110226.ORF'),
  join(TEST_ROOT, 'ADH 1234.CR2'),
  join(TEST_ROOT, 'PXL_20260501_093507165.RAW-02.ORIGINAL.dng'),
];
const OUTPUT_FULL_RGB = 1;
const PROCESS_ARGS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Number.NaN, Number.NaN, 0, 0];
const ENCODE_OPTS = { distance: 1.0, effort: 3, quality: null, progressive: false, previewFirst: false, chunked: false };
const ROI_SIZE = 512;
const TIER = process.argv[2] ?? 'scalar';
const FILE_FILTER = process.argv[3] ?? process.env.BENCH_FILE ?? null;
const VERBOSE = process.env.BENCH_VERBOSE === '1';

class BrowserLikeWorker {
  #worker;
  #onmessage = null;
  #onerror = null;

  constructor(url, options = {}) {
    const workerUrl = url instanceof URL ? url.href : String(url);
    this.#worker = new NodeWorker(new URL('./jxl-worker-shim.mjs', import.meta.url), {
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

function fileType(path) {
  const lower = extname(path).toLowerCase();
  if (lower === '.orf' || lower === '.raw') return 'orf';
  if (lower === '.dng') return 'dng';
  if (lower === '.cr2') return 'cr2';
  throw new Error(`unsupported file: ${path}`);
}

function exactBuffer(view) {
  if (view instanceof ArrayBuffer) return view;
  return view.byteOffset === 0 && view.byteLength === view.buffer.byteLength
    ? view.buffer
    : view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

function concatChunks(chunks) {
  if (chunks.length === 1) return chunks[0];
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const chunk of chunks) {
    out.set(chunk, off);
    off += chunk.byteLength;
  }
  return out;
}

function centerRegion(w, h, size) {
  const cw = Math.min(size, w);
  const ch = Math.min(size, h);
  return {
    x: Math.max(0, Math.floor((w - cw) / 2)),
    y: Math.max(0, Math.floor((h - ch) / 2)),
    w: cw,
    h: ch,
  };
}

async function encodeStandard(rgba, width, height, createEncoder) {
  const started = performance.now();
  const encoder = createEncoder({
    format: 'rgba8',
    width,
    height,
    hasAlpha: true,
    iccProfile: null,
    exif: null,
    xmp: null,
    distance: ENCODE_OPTS.distance,
    quality: ENCODE_OPTS.quality,
    effort: ENCODE_OPTS.effort,
    progressive: ENCODE_OPTS.progressive,
    previewFirst: ENCODE_OPTS.previewFirst,
    chunked: ENCODE_OPTS.chunked,
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
  return { bytes: concatChunks(chunks), ms: performance.now() - started };
}

async function decodeStandard(jxlBytes, width, height, createDecoder) {
  const region = centerRegion(width, height, ROI_SIZE);
  const started = performance.now();
  const decoder = createDecoder({
    format: 'rgba8',
    region,
    downsample: 1,
    progressionTarget: 'final',
    emitEveryPass: false,
    preserveIcc: false,
    preserveMetadata: false,
  });
  const eventTask = (async () => {
    for await (const ev of decoder.events()) {
      if (ev.type === 'error') throw new Error(ev.message);
    }
  })();
  await decoder.push(exactBuffer(jxlBytes));
  await decoder.close();
  await eventTask;
  await decoder.dispose();
  return { ms: performance.now() - started, region };
}

async function encodeTileContainer(rgba, width, height, tileSize, encodeTileContainerRgba8) {
  const started = performance.now();
  const bytes = await encodeTileContainerRgba8(rgba, width, height, {
    tileSize,
    distance: ENCODE_OPTS.distance,
    effort: ENCODE_OPTS.effort,
    hasAlpha: true,
  });
  return { bytes, ms: performance.now() - started };
}

async function decodeTileContainer(bytes, region, decodeTileContainerRegionRgba8) {
  const started = performance.now();
  const result = await decodeTileContainerRegionRgba8(bytes, region);
  return { ms: performance.now() - started, width: result.width, height: result.height };
}

function fmtMs(ms) {
  return `${ms.toFixed(1)} ms`;
}

function fmtKB(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

async function main() {
  if (TIER === 'simd-mt') {
    globalThis.Worker = BrowserLikeWorker;
    globalThis.navigator ??= {};
    globalThis.navigator.hardwareConcurrency ??= 4;
  }

  const initRaw = (await import('./pkg/raw_converter_wasm.js')).default;
  const { process_orf_with_flags, process_dng_with_flags, process_cr2_with_flags, rgb_to_rgba } = await import('./pkg/raw_converter_wasm.js');
  const jxl = await import('./packages/jxl-wasm/dist/index.js');
  const { createDecoder, createEncoder, encodeTileContainerRgba8, decodeTileContainerRegionRgba8, setForcedTier } = jxl;

  await initRaw({
    module_or_path: readFileSync('./pkg/raw_converter_wasm_bg.wasm'),
  });
  setForcedTier(TIER);

  const summary = [];
  const runFiles = FILE_FILTER ? FILES.filter((path) => basename(path) === FILE_FILTER || path.endsWith(FILE_FILTER)) : FILES;
  for (const path of runFiles) {
    if (VERBOSE) console.log(`[file] ${basename(path)} start`);
    const bytes = new Uint8Array(readFileSync(path));
    const type = fileType(path);
    const rawStart = performance.now();
    const result = (() => {
      switch (type) {
        case 'orf': return process_orf_with_flags(bytes, OUTPUT_FULL_RGB, ...PROCESS_ARGS);
        case 'dng': return process_dng_with_flags(bytes, OUTPUT_FULL_RGB, ...PROCESS_ARGS);
        case 'cr2': return process_cr2_with_flags(bytes, OUTPUT_FULL_RGB, ...PROCESS_ARGS);
        default: throw new Error(`unsupported type: ${type}`);
      }
    })();
    const rawMs = performance.now() - rawStart;
    if (VERBOSE) console.log(`[file] ${basename(path)} raw done ${rawMs.toFixed(1)}ms`);
    const rgbaStart = performance.now();
    const rgb = result.take_rgb();
    const rgba = rgb_to_rgba(rgb);
    const rgbaMs = performance.now() - rgbaStart;
    if (VERBOSE) console.log(`[file] ${basename(path)} rgba done ${rgbaMs.toFixed(1)}ms`);
    const width = result.width;
    const height = result.height;

    const standard = await encodeStandard(rgba, width, height, createEncoder);
    if (VERBOSE) console.log(`[file] ${basename(path)} standard encode done ${standard.ms.toFixed(1)}ms`);
    const standardDec = await decodeStandard(standard.bytes, width, height, createDecoder);
    if (VERBOSE) console.log(`[file] ${basename(path)} standard decode done ${standardDec.ms.toFixed(1)}ms`);

    const tile256 = await encodeTileContainer(rgba, width, height, 256, encodeTileContainerRgba8);
    if (VERBOSE) console.log(`[file] ${basename(path)} tile256 encode done ${tile256.ms.toFixed(1)}ms`);
    const tile256Dec = await decodeTileContainer(tile256.bytes, standardDec.region, decodeTileContainerRegionRgba8);
    if (VERBOSE) console.log(`[file] ${basename(path)} tile256 decode done ${tile256Dec.ms.toFixed(1)}ms`);

    const tile512 = await encodeTileContainer(rgba, width, height, 512, encodeTileContainerRgba8);
    if (VERBOSE) console.log(`[file] ${basename(path)} tile512 encode done ${tile512.ms.toFixed(1)}ms`);
    const tile512Dec = await decodeTileContainer(tile512.bytes, standardDec.region, decodeTileContainerRegionRgba8);
    if (VERBOSE) console.log(`[file] ${basename(path)} tile512 decode done ${tile512Dec.ms.toFixed(1)}ms`);

    summary.push({
      file: basename(path),
      type,
      width,
      height,
      sizeMB: bytes.byteLength / 1024 / 1024,
      rawMs,
      rgbaMs,
      standard: {
        encodeMs: standard.ms,
        bytesKB: standard.bytes.byteLength / 1024,
        decodeMs: standardDec.ms,
        roi: standardDec.region,
      },
      tile256: {
        encodeMs: tile256.ms,
        bytesKB: tile256.bytes.byteLength / 1024,
        decodeMs: tile256Dec.ms,
      },
      tile512: {
        encodeMs: tile512.ms,
        bytesKB: tile512.bytes.byteLength / 1024,
        decodeMs: tile512Dec.ms,
      },
    });
    result.free();
  }

  console.log(JSON.stringify({
    buildTier: TIER,
    encodeOptions: ENCODE_OPTS,
    roiSize: ROI_SIZE,
    files: summary,
  }, null, 2));

  if (TIER === 'simd-mt') {
    process.exit(0);
  }
}

await main();
