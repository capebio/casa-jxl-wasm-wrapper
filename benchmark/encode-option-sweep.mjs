/**
 * Benchmark: modular mode and brotliEffort sweep.
 *
 * Measures encode time and output size across modular × brotliEffort combinations.
 * Requires WASM rebuilt with _x bridge functions (extOptions capability).
 * Without rebuilt WASM the benchmark still runs but prints a warning and uses
 * default settings, so output serves as a baseline only.
 *
 * Usage:
 *   node benchmark/encode-option-sweep.mjs
 *
 * Env vars:
 *   SWEEP_FILE   path to a single test file (overrides auto-discovery)
 *   SWEEP_EFFORT encode effort level, default 4
 *   SWEEP_RUNS   encode repetitions per combo, default 2
 */

import { readFileSync, readdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { performance } from "node:perf_hooks";

import initRaw, {
  process_cr2_with_flags,
  process_dng_with_flags,
  process_orf_with_flags,
  rgb_to_rgba,
} from "../pkg/raw_converter_wasm.js";
import { createEncoder, detectTier } from "../packages/jxl-wasm/dist/index.js";

const TEST_ROOT = String.raw`C:\Foo\raw-converter\tests`;
const OUTPUT_FULL_RGB = 1;
const PROCESS_ARGS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Number.NaN, Number.NaN, 0, 0];

function readNumberEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

const SWEEP_EFFORT = readNumberEnv("SWEEP_EFFORT", 4);
const SWEEP_RUNS   = readNumberEnv("SWEEP_RUNS", 2);

// modular: -1=auto (libjxl decides), 0=VarDCT (lossy), 1=Modular
const MODULAR_MODES = [
  { modular: -1, label: "auto" },
  { modular: 0,  label: "VarDCT" },
  { modular: 1,  label: "Modular" },
];

// brotliEffort: -1=libjxl default, then a spread across the 0-11 range
const BROTLI_EFFORTS = [-1, 0, 4, 9, 11];

function fileTypeFromPath(path) {
  const lower = extname(path).toLowerCase();
  if (lower === ".orf" || lower === ".raw") return "orf";
  if (lower === ".dng") return "dng";
  if (lower === ".cr2") return "cr2";
  throw new Error(`Unsupported file type: ${path}`);
}

function processRaw(type, bytes) {
  switch (type) {
    case "orf": return process_orf_with_flags(bytes, OUTPUT_FULL_RGB, ...PROCESS_ARGS);
    case "dng": return process_dng_with_flags(bytes, OUTPUT_FULL_RGB, ...PROCESS_ARGS);
    case "cr2": return process_cr2_with_flags(bytes, OUTPUT_FULL_RGB, ...PROCESS_ARGS);
    default: throw new Error(`Unsupported type: ${type}`);
  }
}

function exactBuffer(view) {
  if (view instanceof ArrayBuffer) return view;
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view.buffer;
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

async function encodeOnce(rgba, width, height, modular, brotliEffort) {
  const encoder = createEncoder({
    format: "rgba8",
    width,
    height,
    hasAlpha: true,
    distance: null,
    quality: 85,
    effort: SWEEP_EFFORT,
    progressive: false,
    previewFirst: false,
    chunked: false,
    modular,
    brotliEffort,
  });
  const chunks = [];
  try {
    const chunkTask = (async () => {
      for await (const chunk of encoder.chunks()) {
        chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
      }
    })();
    await encoder.pushPixels(exactBuffer(rgba));
    await encoder.finish();
    await chunkTask;
    const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
    return total;
  } finally {
    await encoder.dispose();
  }
}

async function sweepCombo(rgba, width, height, modular, brotliEffort) {
  const times = [];
  let lastBytes = 0;
  for (let i = 0; i < SWEEP_RUNS; i++) {
    const t0 = performance.now();
    lastBytes = await encodeOnce(rgba, width, height, modular, brotliEffort);
    times.push(performance.now() - t0);
  }
  return { encodeMs: median(times), jxlBytes: lastBytes };
}

function fmtMs(v) { return `${v.toFixed(0)} ms`; }
function fmtKB(b) { return `${(b / 1024).toFixed(1)} KB`; }
function fmtPct(ratio) { return `${(ratio * 100).toFixed(1)}%`; }

async function main() {
  await initRaw();
  console.log(`\nEncode Option Sweep — effort=${SWEEP_EFFORT}, runs=${SWEEP_RUNS}`);
  console.log(`Tier: ${detectTier()}`);

  // Pick test file
  let testPath = process.env.SWEEP_FILE;
  if (!testPath) {
    const files = readdirSync(TEST_ROOT, { withFileTypes: true })
      .filter(e => e.isFile() && [".orf", ".raw", ".dng", ".cr2"].includes(extname(e.name).toLowerCase()))
      .map(e => join(TEST_ROOT, e.name))
      .sort();
    if (!files.length) {
      console.error(`No test files found in ${TEST_ROOT}. Set SWEEP_FILE=<path> to specify one.`);
      process.exit(1);
    }
    testPath = files[0];
  }

  console.log(`\nFile: ${basename(testPath)}`);
  const bytes = new Uint8Array(readFileSync(testPath));
  const type = fileTypeFromPath(testPath);
  const result = processRaw(type, bytes);
  // Prefer direct RGBA output from WASM to minimize boundary crossings.
  const rgba = (typeof result.take_rgba === 'function')
    ? result.take_rgba()
    : rgb_to_rgba(result.take_rgb());
  const { width, height } = result;
  const pixelBytes = width * height * 4;
  console.log(`Dimensions: ${width}×${height} (${(pixelBytes / 1024 / 1024).toFixed(1)} MB RGBA)`);

  // Warmup
  process.stdout.write("Warming up... ");
  await encodeOnce(new Uint8Array(64 * 64 * 4), 64, 64, -1, -1);
  console.log("done\n");

  // Detect capability
  // We probe by creating a throwaway encoder and checking the underlying module.
  // Simpler: just attempt one encode and catch; the facade silently falls back.
  // We import the internal capability via a test-only sentinel encode and compare.
  // Since we can't directly inspect caps here, we annotate results with a note.

  // Table header
  const COL = [14, 14, 12, 12, 10];
  const header = ["modular", "brotliEffort", "encodeMs", "jxlBytes", "ratio"].map((h, i) => h.padEnd(COL[i])).join(" ");
  const sep = COL.map(w => "-".repeat(w)).join(" ");
  console.log(header);
  console.log(sep);

  const rows = [];
  for (const { modular, label: modLabel } of MODULAR_MODES) {
    for (const brotliEffort of BROTLI_EFFORTS) {
      const beLabel = brotliEffort === -1 ? "default" : String(brotliEffort);
      const { encodeMs, jxlBytes } = await sweepCombo(rgba, width, height, modular, brotliEffort);
      const ratio = jxlBytes / pixelBytes;
      const row = [
        modLabel.padEnd(COL[0]),
        beLabel.padEnd(COL[1]),
        fmtMs(encodeMs).padEnd(COL[2]),
        fmtKB(jxlBytes).padEnd(COL[3]),
        fmtPct(ratio).padEnd(COL[4]),
      ].join(" ");
      console.log(row);
      rows.push({ modular, modLabel, brotliEffort, beLabel, encodeMs, jxlBytes, ratio });
    }
    console.log();
  }

  // Summary: fastest and smallest per modular mode
  console.log("── Summary ──────────────────────────────────────────");
  for (const { modular: m, label: modLabel } of MODULAR_MODES) {
    const subset = rows.filter(r => r.modular === m);
    if (!subset.length) continue;
    const fastest = subset.reduce((a, b) => a.encodeMs < b.encodeMs ? a : b);
    const smallest = subset.reduce((a, b) => a.jxlBytes < b.jxlBytes ? a : b);
    console.log(`${modLabel}: fastest brotliEffort=${fastest.beLabel} (${fmtMs(fastest.encodeMs)}), smallest brotliEffort=${smallest.beLabel} (${fmtKB(smallest.jxlBytes)})`);
  }

  console.log("\nNote: if extOptions capability is absent (old WASM), modular/brotliEffort");
  console.log("settings are silently ignored and all rows reflect default encode settings.");
  console.log("Rebuild WASM with the _x bridge functions to enable full control.\n");
}

main().catch(err => { console.error(err); process.exit(1); });
