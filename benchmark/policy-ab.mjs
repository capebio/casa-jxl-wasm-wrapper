/**
 * A/B benchmark: jxl-policy "viewer" preset (modular=1, brotliEffort=4)
 * vs prior baseline (modular=-1 auto, brotliEffort=-1 default).
 *
 * Runs against a sample of RAW files, encodes each twice (baseline, viewer),
 * records encode_ms + jxl_bytes. Writes CSV + JSON summary to
 * docs/Benchmark results/policy-ab-<timestamp>.{csv,json}.
 *
 * Usage:
 *   node benchmark/policy-ab.mjs
 *
 * Env vars:
 *   AB_SAMPLE   number of files to sample (default 6)
 *   AB_RUNS     encode repetitions per (file, variant), default 3
 *   AB_EFFORT   encode effort, default 4 (matches viewer preset default)
 *   AB_TEST_DIR override test corpus dir
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { performance } from "node:perf_hooks";

import initRaw, {
  process_cr2_with_flags,
  process_dng_with_flags,
  process_orf_with_flags,
  rgb_to_rgba,
} from "../pkg/raw_converter_wasm.js";
import { createEncoder, detectTier } from "../packages/jxl-wasm/dist/index.js";
import { applyEncodePolicy } from "../packages/jxl-policy/dist/index.js";

const TEST_ROOT = process.env.AB_TEST_DIR || String.raw`C:\Foo\raw-converter\tests`;
const OUT_DIR   = String.raw`C:\Foo\raw-converter-wasm\docs\Benchmark results`;
const SAMPLE    = parseInt(process.env.AB_SAMPLE ?? "6", 10);
const RUNS      = parseInt(process.env.AB_RUNS ?? "3", 10);
const EFFORT    = parseInt(process.env.AB_EFFORT ?? "4", 10);

const OUTPUT_FULL_RGB = 1;
const PROCESS_ARGS    = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Number.NaN, Number.NaN, 0, 0];

function processRaw(type, bytes) {
  if (type === "orf") return process_orf_with_flags(bytes, OUTPUT_FULL_RGB, ...PROCESS_ARGS);
  if (type === "dng") return process_dng_with_flags(bytes, OUTPUT_FULL_RGB, ...PROCESS_ARGS);
  if (type === "cr2") return process_cr2_with_flags(bytes, OUTPUT_FULL_RGB, ...PROCESS_ARGS);
  throw new Error(`unsupported: ${type}`);
}

function fileType(p) {
  const ext = extname(p).toLowerCase();
  if (ext === ".orf" || ext === ".raw") return "orf";
  if (ext === ".dng") return "dng";
  if (ext === ".cr2") return "cr2";
  return null;
}

function exactBuffer(view) {
  if (view instanceof ArrayBuffer) return view;
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view.buffer;
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

async function encodeOnce(rgba, width, height, modular, brotliEffort) {
  const encoder = createEncoder({
    format: "rgba8",
    width,
    height,
    hasAlpha: true,
    distance: null,
    quality: 85,
    effort: EFFORT,
    progressive: true,         // matches viewer preset path in production
    previewFirst: true,
    chunked: false,
    modular,
    brotliEffort,
  });
  const chunks = [];
  try {
    const chunkTask = (async () => {
      for await (const c of encoder.chunks()) {
        chunks.push(c instanceof Uint8Array ? c : new Uint8Array(c));
      }
    })();
    await encoder.pushPixels(exactBuffer(rgba));
    await encoder.finish();
    await chunkTask;
    return chunks.reduce((n, a) => n + a.byteLength, 0);
  } finally {
    await encoder.dispose();
  }
}

async function runVariant(label, rgba, width, height, modular, brotliEffort) {
  const times = [];
  let bytes = 0;
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    bytes = await encodeOnce(rgba, width, height, modular, brotliEffort);
    times.push(performance.now() - t0);
  }
  return { label, encodeMs: median(times), jxlBytes: bytes };
}

async function main() {
  await initRaw({ module_or_path: readFileSync(new URL("../pkg/raw_converter_wasm_bg.wasm", import.meta.url)) });
  const tier = detectTier();
  console.log(`[policy-ab] tier=${tier} effort=${EFFORT} runs=${RUNS} sample=${SAMPLE}`);

  // Resolve viewer preset (same call site as web/main.js)
  const viewerOpts = applyEncodePolicy("viewer", {
    format: "rgba8", width: 1, height: 1, hasAlpha: true, effort: EFFORT, progressive: true,
  });
  console.log(`[policy-ab] viewer preset: modular=${viewerOpts.modular} brotliEffort=${viewerOpts.brotliEffort}`);

  const candidates = readdirSync(TEST_ROOT, { withFileTypes: true })
    .filter(e => e.isFile() && fileType(e.name))
    .map(e => join(TEST_ROOT, e.name))
    .sort();
  if (!candidates.length) {
    console.error(`No RAW files in ${TEST_ROOT}`);
    process.exit(1);
  }
  // Even spacing across corpus so we don't bias to one camera/scene
  const step = Math.max(1, Math.floor(candidates.length / SAMPLE));
  const picked = [];
  for (let i = 0; i < candidates.length && picked.length < SAMPLE; i += step) picked.push(candidates[i]);
  console.log(`[policy-ab] files: ${picked.map(p => basename(p)).join(", ")}\n`);

  // Warmup
  await encodeOnce(new Uint8Array(64 * 64 * 4), 64, 64, -1, -1);

  const rows = [];
  for (const path of picked) {
    const name = basename(path);
    process.stdout.write(`[${name}] decode... `);
    const bytes = new Uint8Array(readFileSync(path));
    const decoded = processRaw(fileType(path), bytes);
    const rgba = rgb_to_rgba(decoded.take_rgb());
    const { width, height } = decoded;
    process.stdout.write(`${width}x${height} `);

    const baseline = await runVariant("baseline", rgba, width, height, -1, -1);
    process.stdout.write(`base=${baseline.encodeMs.toFixed(0)}ms `);
    const viewer = await runVariant("viewer", rgba, width, height,
      viewerOpts.modular ?? 1, viewerOpts.brotliEffort ?? 4);
    process.stdout.write(`viewer=${viewer.encodeMs.toFixed(0)}ms `);

    const msDelta  = ((viewer.encodeMs - baseline.encodeMs) / baseline.encodeMs) * 100;
    const sizeDelta = ((viewer.jxlBytes - baseline.jxlBytes) / baseline.jxlBytes) * 100;
    console.log(`Δms=${msDelta.toFixed(1)}% Δsize=${sizeDelta.toFixed(1)}%`);

    rows.push({
      file: name, width, height,
      baseline_ms: baseline.encodeMs, baseline_bytes: baseline.jxlBytes,
      viewer_ms:   viewer.encodeMs,   viewer_bytes:   viewer.jxlBytes,
      ms_delta_pct: msDelta, size_delta_pct: sizeDelta,
    });
  }

  // Aggregates
  const meanMsDelta   = rows.reduce((s, r) => s + r.ms_delta_pct, 0)   / rows.length;
  const meanSizeDelta = rows.reduce((s, r) => s + r.size_delta_pct, 0) / rows.length;
  const speedup       = rows.reduce((s, r) => s + r.baseline_ms / r.viewer_ms, 0) / rows.length;

  console.log(`\n── A/B summary ─────────────────────────────────────`);
  console.log(`tier=${tier}  files=${rows.length}  runs=${RUNS}  effort=${EFFORT}`);
  console.log(`mean Δms   = ${meanMsDelta.toFixed(1)}%  (viewer vs baseline)`);
  console.log(`mean Δsize = ${meanSizeDelta.toFixed(1)}%`);
  console.log(`mean speedup = ${speedup.toFixed(2)}x`);

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const csvPath  = join(OUT_DIR, `policy-ab-${stamp}.csv`);
  const jsonPath = join(OUT_DIR, `policy-ab-${stamp}.json`);

  const csvHeader = "file,width,height,baseline_ms,baseline_bytes,viewer_ms,viewer_bytes,ms_delta_pct,size_delta_pct";
  const csvBody   = rows.map(r =>
    `${r.file},${r.width},${r.height},${r.baseline_ms.toFixed(2)},${r.baseline_bytes},${r.viewer_ms.toFixed(2)},${r.viewer_bytes},${r.ms_delta_pct.toFixed(2)},${r.size_delta_pct.toFixed(2)}`
  ).join("\n");
  writeFileSync(csvPath, csvHeader + "\n" + csvBody + "\n");
  writeFileSync(jsonPath, JSON.stringify({
    tier, effort: EFFORT, runs: RUNS, sample: rows.length,
    viewer_preset: { modular: viewerOpts.modular, brotliEffort: viewerOpts.brotliEffort },
    mean_ms_delta_pct: meanMsDelta, mean_size_delta_pct: meanSizeDelta, mean_speedup: speedup,
    rows,
  }, null, 2));
  console.log(`\nwrote ${csvPath}\nwrote ${jsonPath}\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
