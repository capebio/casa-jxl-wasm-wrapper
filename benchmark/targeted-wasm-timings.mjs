import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { performance } from "node:perf_hooks";

import initRaw, {
  process_cr2_with_flags,
  process_dng_with_flags,
  process_orf_with_flags,
  bench_decode_orf,
  rgb_to_rgba,
} from "../pkg/raw_converter_wasm.js";
import { createDecoder, createEncoder, detectTier, setForcedTier } from "../packages/jxl-wasm/dist/index.js";

const TEST_ROOT = String.raw`C:\Foo\raw-converter\tests`;
const GOB_ROOT = String.raw`C:\995\2026-02-20 Gobabeb To Windhoek`;

const OUTPUT_FULL_RGB = 1;
const PROCESS_ARGS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Number.NaN, Number.NaN, 0, 0];

const ENCODE_OPTIONS = {
  quality: 90,
  effort: 3,
  progressive: false,
  previewFirst: false,
  chunked: false,
  lossless: false,
};

function readNumberEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function readBoolEnv(name) {
  return /^(1|true|yes|on)$/i.test(process.env[name] ?? "");
}

const TEST_RUNS = readNumberEnv("TEST_RUNS", 3);
const TEST_SCAN_LIMIT = readNumberEnv("TEST_SCAN_LIMIT", Infinity);
const GOB_SCAN_LIMIT = readNumberEnv("GOB_SCAN_LIMIT", Infinity);
const GOB_OFFENDER_COUNT = readNumberEnv("GOB_OFFENDER_COUNT", 8);
const GOB_OFFENDER_RUNS = readNumberEnv("GOB_OFFENDER_RUNS", 3);
const TRACE_PROGRESS = readBoolEnv("TRACE_PROGRESS");
const TRACE_STAGES = readBoolEnv("TRACE_STAGES");

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function p95(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return sorted[idx];
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function fmtMs(value) {
  return `${value.toFixed(1)} ms`;
}

function fmtMb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function fmtDims(width, height) {
  return `${width}x${height}`;
}

function exactBuffer(view) {
  if (view instanceof ArrayBuffer) return view;
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view.buffer;
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

function fileTypeFromPath(path) {
  const lower = extname(path).toLowerCase();
  if (lower === ".orf" || lower === ".raw") return "orf";
  if (lower === ".dng") return "dng";
  if (lower === ".cr2") return "cr2";
  throw new Error(`Unsupported file type: ${path}`);
}

function traceProgress(message) {
  if (TRACE_PROGRESS) console.log(message);
}

function traceStage(message) {
  if (TRACE_STAGES) console.log(message);
}

function loadTestFiles() {
  return readdirSync(TEST_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(TEST_ROOT, entry.name))
    .filter((path) => [".orf", ".raw", ".dng", ".cr2"].includes(extname(path).toLowerCase()))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, TEST_SCAN_LIMIT);
}

function loadGobFiles() {
  return readdirSync(GOB_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".orf")
    .map((entry) => join(GOB_ROOT, entry.name))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, GOB_SCAN_LIMIT);
}

function processRaw(type, bytes) {
  switch (type) {
    case "orf":
      return process_orf_with_flags(bytes, OUTPUT_FULL_RGB, ...PROCESS_ARGS);
    case "dng":
      return process_dng_with_flags(bytes, OUTPUT_FULL_RGB, ...PROCESS_ARGS);
    case "cr2":
      return process_cr2_with_flags(bytes, OUTPUT_FULL_RGB, ...PROCESS_ARGS);
    default:
      throw new Error(`Unsupported type: ${type}`);
  }
}

async function encodeJxl(rgba, width, height) {
  const started = performance.now();
  const encoder = createEncoder({
    format: "rgba8",
    width,
    height,
    hasAlpha: true,
    distance: ENCODE_OPTIONS.lossless ? 0 : null,
    quality: ENCODE_OPTIONS.lossless ? null : ENCODE_OPTIONS.quality,
    effort: ENCODE_OPTIONS.effort,
    progressive: ENCODE_OPTIONS.progressive,
    previewFirst: ENCODE_OPTIONS.previewFirst,
    chunked: ENCODE_OPTIONS.chunked,
  });
  const chunks = [];
  let firstChunkMs = null;
  try {
    const chunkTask = (async () => {
      for await (const chunk of encoder.chunks()) {
        if (firstChunkMs == null) firstChunkMs = performance.now() - started;
        chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
      }
    })();
    await encoder.pushPixels(exactBuffer(rgba));
    await encoder.finish();
    await chunkTask;
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      bytes,
      encodeMs: performance.now() - started,
      firstChunkMs: firstChunkMs ?? performance.now() - started,
    };
  } finally {
    await encoder.dispose();
  }
}

async function decodeJxl(bytes) {
  const started = performance.now();
  const decoder = createDecoder({
    format: "rgba8",
    region: null,
    downsample: 1,
    progressionTarget: "final",
    emitEveryPass: false,
    preserveIcc: true,
    preserveMetadata: true,
  });
  try {
    await decoder.push(exactBuffer(bytes));
    await decoder.close();
    let final = null;
    for await (const event of decoder.events()) {
      if (event.type === "final") final = event;
    }
    if (!final) throw new Error("decode produced no final frame");
    return {
      decodeMs: performance.now() - started,
      width: final.info.width,
      height: final.info.height,
    };
  } finally {
    await decoder.dispose();
  }
}

async function warmup() {
  const rgba = new Uint8Array(4 * 4 * 4);
  const encoded = await encodeJxl(rgba, 4, 4);
  await decodeJxl(encoded.bytes);
}

async function measureOne(path) {
  traceStage(`[stage] ${basename(path)} read`);
  const bytes = new Uint8Array(readFileSync(path));
  const type = fileTypeFromPath(path);
  const rawStarted = performance.now();
  traceStage(`[stage] ${basename(path)} raw:start`);
  const result = processRaw(type, bytes);
  const rawWallMs = performance.now() - rawStarted;
  traceStage(`[stage] ${basename(path)} raw:done ${fmtMs(rawWallMs)}`);

  let rawBenchDecompress = null, rawBenchDemosaic = null;
  try {
    const b = bench_decode_orf(bytes);
    rawBenchDecompress = b.decompress_ms;
    rawBenchDemosaic = b.demosaic_ms;
  } catch (e) {}

  try {
    const rgbStarted = performance.now();
    traceStage(`[stage] ${basename(path)} rgba:start`);
    // Prefer direct RGBA output from WASM when available (reduces boundary copies).
    const rgba = (typeof result.take_rgba === 'function')
      ? result.take_rgba()
      : rgb_to_rgba(result.take_rgb());
    const rgbaPrepMs = performance.now() - rgbStarted;
    traceStage(`[stage] ${basename(path)} rgba:done ${fmtMs(rgbaPrepMs)}`);

    traceStage(`[stage] ${basename(path)} encode:start`);
    const encode = await encodeJxl(rgba, result.width, result.height);
    traceStage(`[stage] ${basename(path)} encode:done ${fmtMs(encode.encodeMs)}`);
    traceStage(`[stage] ${basename(path)} decode:start`);
    const decode = await decodeJxl(encode.bytes);
    traceStage(`[stage] ${basename(path)} decode:done ${fmtMs(decode.decodeMs)}`);

    return {
      file: basename(path),
      path,
      type,
      sizeBytes: bytes.byteLength,
      width: result.width,
      height: result.height,
      decompressMs: result.decompress_ms ?? 0,
      demosaicMs: result.demosaic_ms ?? 0,
      tonemapMs: result.tonemap_ms ?? 0,
      orientMs: result.orient_ms ?? 0,
      rawWallMs,
      rawBenchDecompress,
      rawBenchDemosaic,
      rgbaPrepMs,
      encodeMs: encode.encodeMs,
      firstChunkMs: encode.firstChunkMs,
      jxlBytes: encode.bytes.byteLength,
      decodeMs: decode.decodeMs,
    };
  } finally {
    result.free();
  }
}

function collapseRuns(runs) {
  const pick = (key) => median(runs.map((run) => run[key]));
  const first = runs[0];
  return {
    ...first,
    runs: runs.length,
    decompressMs: pick("decompressMs"),
    demosaicMs: pick("demosaicMs"),
    tonemapMs: pick("tonemapMs"),
    orientMs: pick("orientMs"),
    rawWallMs: pick("rawWallMs"),
    rgbaPrepMs: pick("rgbaPrepMs"),
    encodeMs: pick("encodeMs"),
    firstChunkMs: pick("firstChunkMs"),
    decodeMs: pick("decodeMs"),
    jxlBytes: Math.round(median(runs.map((run) => run.jxlBytes))),
  };
}

function derived(row) {
  const rawStageMs = row.decompressMs + row.demosaicMs + row.tonemapMs + row.orientMs;
  const rawMs = row.rawWallMs;
  const rawPlusPrepMs = rawMs + row.rgbaPrepMs;
  const totalMs = rawPlusPrepMs + row.encodeMs + row.decodeMs;
  return { rawStageMs, rawMs, rawPlusPrepMs, totalMs };
}

function printTable(title, rows, limit = rows.length) {
  console.log(`\n=== ${title} ===`);
  for (const row of rows.slice(0, limit)) {
    const extra = derived(row);
    console.log(
      [
        row.file,
        `${row.type.toUpperCase()} ${fmtDims(row.width, row.height)}`,
        fmtMb(row.sizeBytes),
        `rawWall ${fmtMs(row.rawWallMs)}`,
        `decomp ${fmtMs(row.decompressMs)}`,
        `demo ${fmtMs(row.demosaicMs)}`,
        `tone ${fmtMs(row.tonemapMs)}`,
        `prep ${fmtMs(row.rgbaPrepMs)}`,
        `enc ${fmtMs(row.encodeMs)}`,
        `first ${fmtMs(row.firstChunkMs)}`,
        `dec ${fmtMs(row.decodeMs)}`,
        `jxl ${fmtMb(row.jxlBytes)}`,
        `total ${fmtMs(extra.totalMs)}`,
      ].join(" | "),
    );
  }
}

function printAggregate(title, rows) {
  const rawTotals = rows.map((row) => derived(row).rawMs);
  const encodes = rows.map((row) => row.encodeMs);
  const decodes = rows.map((row) => row.decodeMs);
  const totals = rows.map((row) => derived(row).totalMs);

  const med = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  console.log(
    [
      `${title}:`,
      `count=${rows.length}`,
      `rawWall avg ${fmtMs(mean(rawTotals))} med ${fmtMs(med(rawTotals))} p95 ${fmtMs(p95(rawTotals))}`,
      `enc avg ${fmtMs(mean(encodes))} med ${fmtMs(med(encodes))} p95 ${fmtMs(p95(encodes))}`,
      `dec avg ${fmtMs(mean(decodes))} med ${fmtMs(med(decodes))} p95 ${fmtMs(p95(decodes))}`,
      `total avg ${fmtMs(mean(totals))} med ${fmtMs(med(totals))} p95 ${fmtMs(p95(totals))}`,
    ].join(" "),
  );
}

async function runMeasured(paths, runsPerFile) {
  const out = [];
  for (const [pathIndex, path] of paths.entries()) {
    const runs = [];
    for (let i = 0; i < runsPerFile; i += 1) {
      traceProgress(`[progress] measured ${pathIndex + 1}/${paths.length} run ${i + 1}/${runsPerFile} ${basename(path)}`);
      runs.push(await measureOne(path));
    }
    out.push(collapseRuns(runs));
  }
  return out;
}

async function scanGobabebDecode(paths) {
  const rows = [];
  for (const [pathIndex, path] of paths.entries()) {
    traceProgress(`[progress] gob-scan ${pathIndex + 1}/${paths.length} ${basename(path)}`);
    const row = await measureOne(path);
    rows.push(row);
  }
  return rows;
}

function rankWorst(rows) {
  return [...rows].sort((a, b) => derived(b).totalMs - derived(a).totalMs);
}

function exportResultsArtifact(testRows, gobScanRows, gobOffenders, config) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(process.cwd(), "benchmark", "runs");
  mkdirSync(outDir, { recursive: true });

  const artifact = {
    exportedAt: new Date().toISOString(),
    generator: "targeted-wasm-timings",
    config,
    counts: {
      test: testRows.length,
      gobScan: gobScanRows.length,
      offenders: gobOffenders.length,
    },
    summary: {
      testTotalMedian: testRows.length ? median(testRows.map(r => (r.rawWallMs + r.rgbaPrepMs + r.encodeMs + r.decodeMs))) : 0,
      testTotalP95: testRows.length ? p95(testRows.map(r => (r.rawWallMs + r.rgbaPrepMs + r.encodeMs + r.decodeMs))) : 0,
      worstTest: testRows[0] ? { file: testRows[0].file, totalMs: (testRows[0].rawWallMs + testRows[0].rgbaPrepMs + testRows[0].encodeMs + testRows[0].decodeMs) } : null,
    },
    testRows,
    gobScanRows,
    gobOffenders,
  };

  const jsonPath = join(outDir, `targeted-wasm-timings-${ts}.json`);
  writeFileSync(jsonPath, JSON.stringify(artifact, null, 2));
  console.log(`\n[artifact] Wrote ${jsonPath}`);

  if (testRows.length > 0) {
    const csvPath = join(outDir, `targeted-wasm-timings-${ts}.csv`);
    const keys = ["file", "type", "width", "height", "rawWallMs", "decompressMs", "demosaicMs", "tonemapMs", "rgbaPrepMs", "encodeMs", "decodeMs", "jxlBytes", "rawBenchDecompress", "rawBenchDemosaic"];
    const lines = [keys.join(",")];
    for (const r of testRows) {
      lines.push(keys.map(k => {
        const v = r[k];
        return (v == null) ? "" : (typeof v === "number" ? v.toFixed(1) : String(v).replace(/,/g, ""));
      }).join(","));
    }
    writeFileSync(csvPath, lines.join("\n"));
    console.log(`[artifact] Wrote ${csvPath}`);
  }
}

async function main() {
  setForcedTier("simd");
  console.log("targeted-wasm-timings");
  console.log(`detected-tier=${detectTier()} forced-tier=simd quality=${ENCODE_OPTIONS.quality} effort=${ENCODE_OPTIONS.effort} progressive=${ENCODE_OPTIONS.progressive}`);
  console.log(`config testRuns=${TEST_RUNS} testScanLimit=${TEST_SCAN_LIMIT} gobScanLimit=${GOB_SCAN_LIMIT} gobOffenderCount=${GOB_OFFENDER_COUNT} gobOffenderRuns=${GOB_OFFENDER_RUNS} traceProgress=${TRACE_PROGRESS} traceStages=${TRACE_STAGES}`);
  const rawWasmBytes = readFileSync(new URL("../pkg/raw_converter_wasm_bg.wasm", import.meta.url));
  await initRaw({ module_or_path: rawWasmBytes });
  await warmup();

  const testFiles = loadTestFiles();
  console.log(`tests: ${testFiles.length} files`);
  const testRows = rankWorst(await runMeasured(testFiles, TEST_RUNS));
  printTable("Tests Ranked By Total", testRows);
  printAggregate("Tests aggregate", testRows);

  const gobFiles = loadGobFiles();
  console.log(`\nGobabeb scan: ${gobFiles.length} files`);
  const gobScanRows = rankWorst(await scanGobabebDecode(gobFiles));
  printTable("Gobabeb Scan Top 12", gobScanRows, 12);
  printAggregate("Gobabeb scan aggregate", gobScanRows);

  const offenderPaths = gobScanRows.slice(0, GOB_OFFENDER_COUNT).map((row) => row.path);
  console.log(`\nGobabeb offenders: ${offenderPaths.length} files re-run ${GOB_OFFENDER_RUNS}x`);
  const gobOffenders = rankWorst(await runMeasured(offenderPaths, GOB_OFFENDER_RUNS));
  printTable("Gobabeb Offenders Re-measured", gobOffenders);
  printAggregate("Gobabeb offenders aggregate", gobOffenders);

  exportResultsArtifact(testRows, gobScanRows, gobOffenders, {
    TEST_RUNS, TEST_SCAN_LIMIT, GOB_SCAN_LIMIT,
    GOB_OFFENDER_COUNT, GOB_OFFENDER_RUNS,
    TRACE_PROGRESS, TRACE_STAGES,
    quality: ENCODE_OPTIONS.quality,
    effort: ENCODE_OPTIONS.effort,
  });

  const worst = gobOffenders[0];
  if (worst) {
    const extra = derived(worst);
    console.log(
      [
        "\nworst-offender:",
        worst.file,
        `rawWall=${fmtMs(extra.rawMs)}`,
        `decomp=${fmtMs(worst.decompressMs)}`,
        `demo=${fmtMs(worst.demosaicMs)}`,
        `tone=${fmtMs(worst.tonemapMs)}`,
        `enc=${fmtMs(worst.encodeMs)}`,
        `dec=${fmtMs(worst.decodeMs)}`,
        `total=${fmtMs(extra.totalMs)}`,
      ].join(" "),
    );
  }
}

await main();
