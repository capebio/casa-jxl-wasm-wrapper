import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Worker as NodeWorker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const GOB_ROOT = String.raw`C:\995\2026-02-20 Gobabeb To Windhoek`;
const TEST_ROOT = String.raw`C:\Foo\raw-converter\tests`;
const GOB_START = process.env.GOB_START ?? 'P2200475 Kissenia capensis.ORF';
const GOB_COUNT = 10;

const OUTPUT_FULL_RGB = 1;
const PROCESS_ARGS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Number.NaN, Number.NaN, 0, 0];
const BASE_ENCODE = {
  distance: 1.0,
  effort: 3,
  quality: null,
  progressive: false,
  previewFirst: false,
};
const TIERS = ['simd', 'simd-mt'];
const STANDARD_VARIANTS = [
  { name: 'std', chunked: false, modular: false },
  { name: 'std+chunked', chunked: true, modular: false },
  { name: 'std+modular', chunked: false, modular: true },
  { name: 'std+chunked+modular', chunked: true, modular: true },
];
const TILE_SIZES = [256, 512];
const FILE_FILTER = process.argv[2] ?? null;
const VERBOSE = process.env.BENCH_VERBOSE === '1';
const STAGE_TIMEOUT_MS = Number(process.env.BENCH_STAGE_TIMEOUT_MS ?? '0') || 0;
const BATCH_SIZE = Math.max(1, Number(process.env.BENCH_BATCH_SIZE ?? '2') || 2);
const FILE_LIMIT = parsePositiveInt(process.env.BENCH_LIMIT ?? '');
const ROI_SIZE = parsePositiveInt(process.env.BENCH_ROI_SIZE ?? '') ?? 512;
const REPEAT_COUNT = parsePositiveInt(process.env.BENCH_REPEATS ?? '') ?? 1;
const WARMUP_COUNT = parseNonNegativeInt(process.env.BENCH_WARMUP ?? '') ?? 0;
const FORMAT_FILTER = parseFormatFilter(process.env.BENCH_FORMATS ?? '');
const TIER_FILTER = parseTierFilter(process.env.BENCH_TIERS ?? '');
const TILE_SIZE_FILTER = parseTileSizeFilter(process.env.BENCH_TILE_SIZES ?? '');
const STANDARD_VARIANT_FILTER = parseVariantFilter(process.env.BENCH_STANDARD_VARIANTS ?? '');
const FINAL_OUTPUT = resolve(process.env.BENCH_OUTPUT ?? fileURLToPath(new URL('./raw-format-sweep-results.json', import.meta.url)));

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

function fmtMs(ms) {
  return `${ms.toFixed(1)} ms`;
}

function fmtKB(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

function stddev(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const variance = mean(values.map((value) => (value - avg) ** 2));
  return Math.sqrt(variance);
}

function stats(values) {
  return {
    count: values.length,
    mean: mean(values),
    median: median(values),
    p95: percentile(values, 0.95),
    min: values.length ? Math.min(...values) : 0,
    max: values.length ? Math.max(...values) : 0,
    stddev: stddev(values),
  };
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
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function chunkFiles(files, size) {
  const batches = [];
  for (let index = 0; index < files.length; index += size) {
    batches.push(files.slice(index, index + size));
  }
  return batches;
}

function parseFormatFilter(raw) {
  if (!raw.trim()) return null;
  const formats = raw
    .split(',')
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
  return formats.length ? new Set(formats) : null;
}

function parsePositiveInt(raw) {
  if (!raw.trim()) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function parseNonNegativeInt(raw) {
  if (!raw.trim()) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function parseTierFilter(raw) {
  if (!raw.trim()) return null;
  const tiers = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return tiers.length ? new Set(tiers) : null;
}

function parseTileSizeFilter(raw) {
  if (!raw.trim()) return null;
  const sizes = raw
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
  return sizes.length ? new Set(sizes) : null;
}

function parseVariantFilter(raw) {
  if (!raw.trim()) return null;
  const variants = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return variants.length ? new Set(variants) : null;
}

function derivePartialOutput(finalOutput) {
  const ext = extname(finalOutput);
  const base = ext ? finalOutput.slice(0, -ext.length) : finalOutput;
  return `${base}.partial${ext || '.json'}`;
}

function fileType(path) {
  const lower = extname(path).toLowerCase();
  if (lower === '.orf' || lower === '.raw') return 'orf';
  if (lower === '.dng') return 'dng';
  if (lower === '.cr2') return 'cr2';
  throw new Error(`unsupported file: ${path}`);
}

function selectGobFiles() {
  const files = readdirSync(GOB_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.orf')
    .map((entry) => join(GOB_ROOT, entry.name))
    .sort((a, b) => a.localeCompare(b));
  const startIndex = files.findIndex((path) => basename(path) === GOB_START);
  if (startIndex < 0) {
    if (files.length === 0) return [];
    console.warn(`[warn] Gobabeb start file not found: ${GOB_START}; starting at ${basename(files[0])}`);
    return files.slice(0, GOB_COUNT);
  }
  return files.slice(startIndex, startIndex + GOB_COUNT);
}

function selectRefFiles() {
  return readdirSync(TEST_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && ['.cr2', '.dng'].includes(extname(entry.name).toLowerCase()))
    .map((entry) => join(TEST_ROOT, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

function makeFileSet() {
  const files = [
    ...selectGobFiles(),
    ...selectRefFiles(),
  ];
  const filtered = files.filter((path) => {
    const matchesFile = !FILE_FILTER || basename(path) === FILE_FILTER || path.endsWith(FILE_FILTER);
    const matchesFormat = !FORMAT_FILTER || FORMAT_FILTER.has(fileType(path).toUpperCase());
    return matchesFile && matchesFormat;
  });
  return FILE_LIMIT ? filtered.slice(0, FILE_LIMIT) : filtered;
}

function processRaw(type, bytes, process_orf_with_flags, process_dng_with_flags, process_cr2_with_flags) {
  switch (type) {
    case 'orf': return process_orf_with_flags(bytes, OUTPUT_FULL_RGB, ...PROCESS_ARGS);
    case 'dng': return process_dng_with_flags(bytes, OUTPUT_FULL_RGB, ...PROCESS_ARGS);
    case 'cr2': return process_cr2_with_flags(bytes, OUTPUT_FULL_RGB, ...PROCESS_ARGS);
    default: throw new Error(`unsupported type: ${type}`);
  }
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

async function encodeStandard(rgba, width, height, createEncoder, variant) {
  if (VERBOSE) console.log(`[stage] standard encode start ${variant.name}`);
  const started = performance.now();
  const encoder = createEncoder({
    format: 'rgba8',
    width,
    height,
    hasAlpha: true,
    distance: BASE_ENCODE.distance,
    quality: BASE_ENCODE.quality,
    effort: BASE_ENCODE.effort,
    progressive: BASE_ENCODE.progressive,
    previewFirst: BASE_ENCODE.previewFirst,
    chunked: variant.chunked,
    modular: variant.modular,
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
  if (VERBOSE) console.log(`[stage] standard encode done ${variant.name} ${fmtMs(performance.now() - started)}`);
  return { bytes: concatChunks(chunks), ms: performance.now() - started };
}

async function decodeStandard(jxlBytes, width, height, createDecoder) {
  if (VERBOSE) console.log('[stage] standard decode start');
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
  if (VERBOSE) console.log(`[stage] standard decode done ${fmtMs(performance.now() - started)}`);
  return { ms: performance.now() - started, region };
}

async function encodeTileContainer(rgba, width, height, tileSize, encodeTileContainerRgba8) {
  if (VERBOSE) console.log(`[stage] tile${tileSize} encode start`);
  const started = performance.now();
  const bytes = await encodeTileContainerRgba8(rgba, width, height, {
    tileSize,
    distance: BASE_ENCODE.distance,
    effort: BASE_ENCODE.effort,
    hasAlpha: true,
  });
  if (VERBOSE) console.log(`[stage] tile${tileSize} encode done ${fmtMs(performance.now() - started)}`);
  return { bytes, ms: performance.now() - started };
}

async function decodeTileContainer(bytes, region, decodeTileContainerRegionRgba8) {
  if (VERBOSE) console.log('[stage] tile decode start');
  const started = performance.now();
  const result = await decodeTileContainerRegionRgba8(bytes, region);
  if (VERBOSE) console.log(`[stage] tile decode done ${fmtMs(performance.now() - started)}`);
  return { ms: performance.now() - started, width: result.width, height: result.height };
}

async function measureFileRun(
  path,
  tier,
  createDecoder,
  createEncoder,
  encodeTileContainerRgba8,
  decodeTileContainerRegionRgba8,
  process_orf_with_flags,
  process_dng_with_flags,
  process_cr2_with_flags,
  rgb_to_rgba,
  standardVariants,
  tileSizes,
  runIndex,
) {
  const bytes = new Uint8Array(readFileSync(path));
  const type = fileType(path);
  const rawStarted = performance.now();
  const result = processRaw(type, bytes, process_orf_with_flags, process_dng_with_flags, process_cr2_with_flags);
  try {
    const rawMs = performance.now() - rawStarted;

    // Read per-stage timings from ProcessResult (available for ORF, DNG, CR2).
    const decompressMs = result.decompress_ms;
    const demosaicMs = result.demosaic_ms;
    const tonemapMs = result.tonemap_ms;
    const orientMs = result.orient_ms;

    const rgbaStarted = performance.now();
    const rgb = result.take_rgb();
    const rgba = rgb_to_rgba(rgb);
    const rgbaMs = performance.now() - rgbaStarted;
    const width = result.width;
    const height = result.height;
    const format = type.toUpperCase();
    const rows = [];

    for (const variant of standardVariants) {
      const standard = await withTimeout(
        encodeStandard(rgba, width, height, createEncoder, variant),
        `encode ${basename(path)} ${tier} ${variant.name}`,
      );
      const standardDec = await withTimeout(
        decodeStandard(standard.bytes, width, height, createDecoder),
        `decode ${basename(path)} ${tier} ${variant.name}`,
      );
      rows.push({
        file: basename(path),
        format,
        tier,
        chunked: variant.chunked,
        modular: variant.modular,
        mode: variant.name,
        run: runIndex,
        rawMs,
        decompressMs,
        demosaicMs,
        tonemapMs,
        orientMs,
        rgbaMs,
        encodeMs: standard.ms,
        decodeMs: standardDec.ms,
        totalMs: rawMs + rgbaMs + standard.ms + standardDec.ms,
        sizeKB: standard.bytes.byteLength / 1024,
      });
    }

    for (const tileSize of tileSizes) {
      const tiled = await withTimeout(
        encodeTileContainer(rgba, width, height, tileSize, encodeTileContainerRgba8),
        `tile${tileSize} encode ${basename(path)} ${tier}`,
      );
      const tiledDec = await withTimeout(
        decodeTileContainer(tiled.bytes, centerRegion(width, height, ROI_SIZE), decodeTileContainerRegionRgba8),
        `tile${tileSize} decode ${basename(path)} ${tier}`,
      );
      rows.push({
        file: basename(path),
        format,
        tier,
        chunked: false,
        modular: false,
        mode: `tile${tileSize}`,
        run: runIndex,
        tileSize,
        rawMs,
        decompressMs,
        demosaicMs,
        tonemapMs,
        orientMs,
        rgbaMs,
        encodeMs: tiled.ms,
        decodeMs: tiledDec.ms,
        totalMs: rawMs + rgbaMs + tiled.ms + tiledDec.ms,
        sizeKB: tiled.bytes.byteLength / 1024,
      });
    }

    return rows;
  } finally {
    result.free();
  }
}

function buildSummary(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = `${row.format}|${row.mode}|tier=${row.tier}|chunked=${row.chunked}|modular=${row.modular}`;
    const group = byKey.get(key) ?? [];
    group.push(row);
    byKey.set(key, group);
  }

  return [...byKey.entries()].map(([key, group]) => {
    const raw = stats(group.map((row) => row.rawMs));
    const decompress = stats(group.map((row) => row.decompressMs));
    const demosaic = stats(group.map((row) => row.demosaicMs));
    const tonemap = stats(group.map((row) => row.tonemapMs));
    const enc = stats(group.map((row) => row.encodeMs));
    const dec = stats(group.map((row) => row.decodeMs));
    const total = stats(group.map((row) => row.totalMs));
    const size = stats(group.map((row) => row.sizeKB));
    return { key, count: group.length, raw, decompress, demosaic, tonemap, encode: enc, decode: dec, total, size };
  }).sort((a, b) => a.key.localeCompare(b.key));
}

function selectedStandardVariants() {
  const variants = STANDARD_VARIANT_FILTER
    ? STANDARD_VARIANTS.filter((variant) => STANDARD_VARIANT_FILTER.has(variant.name))
    : STANDARD_VARIANTS;
  if (!variants.length) {
    throw new Error(`no standard variants selected from BENCH_STANDARD_VARIANTS=${process.env.BENCH_STANDARD_VARIANTS ?? ''}`);
  }
  return variants;
}

function selectedTileSizes() {
  const sizes = TILE_SIZE_FILTER ? TILE_SIZES.filter((size) => TILE_SIZE_FILTER.has(size)) : TILE_SIZES;
  if (!sizes.length) {
    throw new Error(`no tile sizes selected from BENCH_TILE_SIZES=${process.env.BENCH_TILE_SIZES ?? ''}`);
  }
  return sizes;
}

function printSummary(title, summaries) {
  console.log(`\n=== ${title} ===`);
  for (const s of summaries) {
    console.log([
      s.key,
      `n=${s.count}`,
      `raw mean ${fmtMs(s.raw.mean)} med ${fmtMs(s.raw.median)} p95 ${fmtMs(s.raw.p95)}`,
      `  decomp mean ${fmtMs(s.decompress.mean)} demosaic mean ${fmtMs(s.demosaic.mean)} tonemap mean ${fmtMs(s.tonemap.mean)}`,
      `enc mean ${fmtMs(s.encode.mean)} med ${fmtMs(s.encode.median)} p95 ${fmtMs(s.encode.p95)}`,
      `dec mean ${fmtMs(s.decode.mean)} med ${fmtMs(s.decode.median)} p95 ${fmtMs(s.decode.p95)}`,
      `tot mean ${fmtMs(s.total.mean)} med ${fmtMs(s.total.median)} p95 ${fmtMs(s.total.p95)}`,
      `size mean ${s.size.mean.toFixed(1)} KB`,
    ].join(' | '));
  }
}

function tryWriteJson(target, payload) {
  try {
    writeFileSync(target, payload);
    return true;
  } catch (error) {
    console.warn(`[warn] could not write ${target}: ${error?.message ?? error}`);
    return false;
  }
}

function persistResults(kind, out) {
  const payload = JSON.stringify(out, null, 2);
  const primaryOut = kind === 'final' ? FINAL_OUTPUT : derivePartialOutput(FINAL_OUTPUT);
  const fallbackOut = kind === 'final'
    ? String.raw`C:\Tmp\raw-format-sweep-results.json`
    : String.raw`C:\Tmp\raw-format-sweep-results.partial.json`;
  const wrote = tryWriteJson(primaryOut, payload) || tryWriteJson(fallbackOut, payload);
  if (!wrote) {
    console.warn(`[warn] skipped ${kind} results file write; file output is blocked in this environment`);
  }
}

function withTimeout(promise, label) {
  if (!STAGE_TIMEOUT_MS) return promise;
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${STAGE_TIMEOUT_MS} ms`)), STAGE_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function withTier(tier, fn) {
  const isMt = tier === 'simd-mt';
  if (isMt) {
    globalThis.Worker = BrowserLikeWorker;
    globalThis.navigator ??= {};
    globalThis.navigator.hardwareConcurrency ??= 4;
  }
  const jxl = await import('../packages/jxl-wasm/dist/index.js');
  const { createDecoder, createEncoder, encodeTileContainerRgba8, decodeTileContainerRegionRgba8, setForcedTier } = jxl;
  setForcedTier(tier);
  return fn({ createDecoder, createEncoder, encodeTileContainerRgba8, decodeTileContainerRegionRgba8, setForcedTier });
}

async function main() {
  const files = makeFileSet();
  if (!files.length) {
    throw new Error('no files selected');
  }
  const batches = chunkFiles(files, BATCH_SIZE);
  const activeTiers = TIER_FILTER ? TIERS.filter((tier) => TIER_FILTER.has(tier)) : TIERS;
  if (!activeTiers.length) {
    throw new Error(`no tiers selected from BENCH_TIERS=${process.env.BENCH_TIERS ?? ''}`);
  }
  const activeStandardVariants = selectedStandardVariants();
  const activeTileSizes = selectedTileSizes();

  const initRaw = (await import('../pkg/raw_converter_wasm.js')).default;
  const { process_orf_with_flags, process_dng_with_flags, process_cr2_with_flags, rgb_to_rgba } = await import('../pkg/raw_converter_wasm.js');
  await initRaw({ module_or_path: readFileSync(new URL('../pkg/raw_converter_wasm_bg.wasm', import.meta.url)) });

  const rows = [];
  for (const tier of activeTiers) {
    if (VERBOSE) console.log(`[tier] ${tier} start`);
    await withTier(tier, async ({ createDecoder, createEncoder, encodeTileContainerRgba8, decodeTileContainerRegionRgba8, setForcedTier }) => {
      for (const [batchIndex, batchFiles] of batches.entries()) {
        const batchStarted = performance.now();
        const batchRowStart = rows.length;
        console.log(`[batch] tier=${tier} ${batchIndex + 1}/${batches.length} start files=${batchFiles.length}`);
        for (const path of batchFiles) {
          if (VERBOSE) console.log(`[file] ${tier} ${basename(path)} start`);
          for (let warmupIndex = 0; warmupIndex < WARMUP_COUNT; warmupIndex += 1) {
            if (VERBOSE) console.log(`[warmup] ${tier} ${basename(path)} ${warmupIndex + 1}/${WARMUP_COUNT}`);
            await measureFileRun(
              path,
              tier,
              createDecoder,
              createEncoder,
              encodeTileContainerRgba8,
              decodeTileContainerRegionRgba8,
              process_orf_with_flags,
              process_dng_with_flags,
              process_cr2_with_flags,
              rgb_to_rgba,
              activeStandardVariants,
              activeTileSizes,
              -1,
            );
          }
          for (let runIndex = 0; runIndex < REPEAT_COUNT; runIndex += 1) {
            if (VERBOSE) console.log(`[run] ${tier} ${basename(path)} ${runIndex + 1}/${REPEAT_COUNT}`);
            const runRows = await measureFileRun(
              path,
              tier,
              createDecoder,
              createEncoder,
              encodeTileContainerRgba8,
              decodeTileContainerRegionRgba8,
              process_orf_with_flags,
              process_dng_with_flags,
              process_cr2_with_flags,
              rgb_to_rgba,
              activeStandardVariants,
              activeTileSizes,
              runIndex + 1,
            );
            rows.push(...runRows);
          }
        }
        console.log(`[batch] tier=${tier} ${batchIndex + 1}/${batches.length} done files=${batchFiles.length} rows=${rows.length - batchRowStart} elapsed=${fmtMs(performance.now() - batchStarted)}`);
        persistResults('partial', {
          files: files.map((path) => basename(path)),
          batchSize: BATCH_SIZE,
          fileLimit: FILE_LIMIT,
          roiSize: ROI_SIZE,
          repeats: REPEAT_COUNT,
          warmup: WARMUP_COUNT,
          batchIndex: batchIndex + 1,
          batchCount: batches.length,
          tiers: activeTiers,
          tiersFilter: TIER_FILTER ? [...TIER_FILTER] : null,
          standardVariants: activeStandardVariants,
          standardVariantsFilter: STANDARD_VARIANT_FILTER ? [...STANDARD_VARIANT_FILTER] : null,
          tileSizes: activeTileSizes,
          tileSizesFilter: TILE_SIZE_FILTER ? [...TILE_SIZE_FILTER] : null,
          rows,
          summary: buildSummary(rows),
          byFormat: ['ORF', 'CR2', 'DNG']
            .filter((format) => !FORMAT_FILTER || FORMAT_FILTER.has(format))
            .map((format) => ({
              format,
              summaries: buildSummary(rows.filter((row) => row.format === format)),
            })),
        });
      }
    });
  }

  const summary = buildSummary(rows);
  printSummary('All configs', summary);

  const byFormat = ['ORF', 'CR2', 'DNG'].map((format) => ({
    format,
    summaries: buildSummary(rows.filter((row) => row.format === format)),
  }));
  for (const entry of byFormat) {
    printSummary(entry.format, entry.summaries);
  }

  const out = {
    files: files.map((path) => basename(path)),
    batchSize: BATCH_SIZE,
    fileLimit: FILE_LIMIT,
    roiSize: ROI_SIZE,
    repeats: REPEAT_COUNT,
    warmup: WARMUP_COUNT,
    formats: FORMAT_FILTER ? [...FORMAT_FILTER] : null,
    tiers: activeTiers,
    tiersFilter: TIER_FILTER ? [...TIER_FILTER] : null,
    standardVariants: activeStandardVariants,
    standardVariantsFilter: STANDARD_VARIANT_FILTER ? [...STANDARD_VARIANT_FILTER] : null,
    tileSizes: activeTileSizes,
    tileSizesFilter: TILE_SIZE_FILTER ? [...TILE_SIZE_FILTER] : null,
    rows,
    summary,
    byFormat,
  };
  persistResults('final', out);
}

await main();
