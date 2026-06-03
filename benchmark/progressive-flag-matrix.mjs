/**
 * Progressive encoder flag truth matrix.
 *
 * Usage:
 *   PFM_LIMIT=1 PFM_TARGET=1600 PFM_QUALITY=85 node benchmark/progressive-flag-matrix.mjs
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

import initRaw, {
  downscale_rgb,
  process_orf_with_flags,
  rgb_to_rgba,
} from "../pkg/raw_converter_wasm.js";
import { buildByteCutoffPlan } from "../web/jxl-byte-cutoff-probe.js";
import { createProgressiveWebPreset } from "../web/jxl-progressive-best-preset.js";
import { classifyByteCutoffFrame, summarizeByteCutoffResults } from "../web/jxl-progressive-byte-metrics.js";
import {
  exactBuffer,
  concatChunks,
  waitForStreamEvents,
  streamDecodeCutoffs,
  computeQualitySeries,
} from "./_progressive-stream-helper.mjs";

const GOBABEB_DIR = String.raw`C:\995\2026-02-20 Gobabeb To Windhoek`;
const OUT_DIR = String.raw`C:\Foo\raw-converter-wasm\docs\Benchmark results`;
const OUTPUT_FULL_RGB = 1;
const PROCESS_ARGS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Number.NaN, Number.NaN, 0, 0];

const LIMIT = clampInt(process.env.PFM_LIMIT ?? "1", 1, 100);
const START = clampInt(process.env.PFM_START ?? "0", 0, 1000);
const SORT = process.env.PFM_SORT ?? "size-desc";
const TARGET = process.env.PFM_TARGET ?? "1600";
const QUALITY = clampInt(process.env.PFM_QUALITY ?? "85", 1, 100);
const DETAIL = process.env.PFM_DETAIL ?? "passes";
const WAIT_MS = clampInt(process.env.PFM_WAIT_MS ?? "0", 0, 1000);

const MATRIX_CASES = Object.freeze([
  { name: "dc1-only",       progressiveDc: 1, progressiveAc: 0, qProgressiveAc: 0, groupOrder: 1 },
  { name: "dc2-only",       progressiveDc: 2, progressiveAc: 0, qProgressiveAc: 0, groupOrder: 1 },
  { name: "dc2-ac-only",    progressiveDc: 2, progressiveAc: 1, qProgressiveAc: 0, groupOrder: 1 },
  { name: "dc2-q-only",     progressiveDc: 2, progressiveAc: 0, qProgressiveAc: 1, groupOrder: 1 },
  { name: "dc2-ac-q",       progressiveDc: 2, progressiveAc: 1, qProgressiveAc: 1, groupOrder: 1 },
  { name: "dc2-q-scanline", progressiveDc: 2, progressiveAc: 0, qProgressiveAc: 1, groupOrder: 0 },
  { name: "sneyers",        progressiveDc: 2, progressiveAc: 1, qProgressiveAc: 1, groupOrder: 1, decodingSpeed: 0 },
]);

const EFFORT_SWEEP = Object.freeze([3, 5]);

let createDecoder;
let createEncoder;
let detectTier;

async function mainCollect() {
  if (typeof globalThis.Worker === "undefined" && !process.env.JXL_WASM_FORCE_TIER) {
    process.env.JXL_WASM_FORCE_TIER = "simd";
  }
  ({ createDecoder, createEncoder, detectTier } = await import("../packages/jxl-wasm/dist/index.js"));
  await initRaw({ module_or_path: readFileSync(new URL("../pkg/raw_converter_wasm_bg.wasm", import.meta.url)) });
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  const files = selectFiles();
  if (files.length === 0) throw new Error(`No ORFs found in ${GOBABEB_DIR}`);
  const tier = detectTier();
  console.log(`[progressive-flag-matrix] tier=${tier} files=${files.length} target=${TARGET} quality=${QUALITY} detail=${DETAIL} wait=${WAIT_MS}ms`);

  const results = [];
  for (const file of files) {
    console.log(`[progressive-flag-matrix] ${basename(file)}`);
    const raw = new Uint8Array(readFileSync(file));
    const decoded = process_orf_with_flags(raw, OUTPUT_FULL_RGB, ...PROCESS_ARGS);
    try {
      const rgb = decoded.take_rgb();
      const source = { width: decoded.width, height: decoded.height, rgb };
      const targetLongEdge = TARGET === "full" ? "full" : Number(TARGET);
      const basePreset = createProgressiveWebPreset({
        width: source.width,
        height: source.height,
        targetLongEdge,
        quality: QUALITY,
        progressiveDetail: DETAIL,
      });
      const rgba = makeTargetRgba(source, basePreset.target.width, basePreset.target.height);
      const cases = [];
      for (const effort of EFFORT_SWEEP) {
        for (const matrixCase of MATRIX_CASES) {
          const encodeOptions = {
            ...basePreset.encode,
            progressiveFlavor: "dc",
            previewFirst: true,
            progressiveDc: matrixCase.progressiveDc,
            progressiveAc: matrixCase.progressiveAc,
            qProgressiveAc: matrixCase.qProgressiveAc,
            groupOrder: matrixCase.groupOrder,
            effort,
            ...(matrixCase.decodingSpeed !== undefined ? { decodingSpeed: matrixCase.decodingSpeed } : {}),
          };
          const caseName = `${matrixCase.name}-e${effort}`;
          const t0 = performance.now();
          const jxlBytes = await encodeTarget(rgba, encodeOptions);
          const encodeMs = performance.now() - t0;
          const streamed = await streamDecodeCutoffs(jxlBytes, buildByteCutoffPlan(jxlBytes.byteLength), basePreset.decode, { createDecoder, waitMs: WAIT_MS });
          const qualitySeries = await computeQualitySeries(streamed.cutoffs);
          const cutoffs = streamed.cutoffs.map((cutoff) => classifyByteCutoffFrame(cutoff));
          const summary = summarizeByteCutoffResults(cutoffs, jxlBytes.byteLength, { qualitySeries });
          const targetUsefulEarlyPaint = summary.usefulEarlyPaint;
          cases.push({ name: caseName, effort, ...matrixCase, encode: encodeOptions, encodeMs, jxlBytes: jxlBytes.byteLength, targetUsefulEarlyPaint, summary, cutoffs, qualitySeries });
          console.log(`  ${caseName.padEnd(22)} jxl=${fmtBytes(jxlBytes.byteLength)} first=${fmtBytes(summary.firstPaintBytes)} recog=${fmtBytes(summary.firstRecognizableBytes)} preview=${fmtBytes(summary.previewBytes)} paints=${summary.paintedCutoffs} mono=${summary.monotone} finalPsnr=${summary.finalPsnr?.toFixed(1)}`);
        }
      }
      results.push({
        file: basename(file),
        rawBytes: raw.byteLength,
        source: { width: source.width, height: source.height },
        target: basePreset.target,
        cases,
      });
    } finally {
      decoded.free();
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = join(OUT_DIR, `progressive-flag-matrix-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify({
    exportedAt: new Date().toISOString(),
    generator: "progressive-flag-matrix",
    tier,
    target: TARGET,
    quality: QUALITY,
    detail: DETAIL,
    matrixCases: MATRIX_CASES,
    effortSweep: EFFORT_SWEEP,
    results,
  }, null, 2));
  console.log(`[progressive-flag-matrix] wrote ${outPath}`);
  return results;
}

async function main() { await mainCollect(); }

export async function runMatrix() { return await mainCollect(); }

function selectFiles() {
  const entries = readdirSync(GOBABEB_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".orf")
    .map((entry) => {
      const path = join(GOBABEB_DIR, entry.name);
      return { path, size: statSync(path).size };
    });
  const sorted = SORT === "name-asc"
    ? entries.sort((a, b) => a.path.localeCompare(b.path))
    : SORT === "name-desc"
      ? entries.sort((a, b) => b.path.localeCompare(a.path))
      : entries.sort((a, b) => b.size - a.size);
  return sorted.slice(START, START + LIMIT).map((entry) => entry.path);
}

function makeTargetRgba(source, width, height) {
  if (source.width === width && source.height === height) return rgb_to_rgba(source.rgb);
  return rgb_to_rgba(downscale_rgb(source.rgb, source.width, source.height, width, height));
}

async function encodeTarget(rgba, encodeOptions) {
  const encoder = createEncoder(encodeOptions);
  const chunks = [];
  const chunkTask = (async () => {
    for await (const chunk of encoder.chunks()) chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
  })();
  await encoder.pushPixels(exactBuffer(rgba));
  await encoder.finish();
  await chunkTask;
  await encoder.dispose();
  return concatChunks(chunks);
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return "--";
  const units = ["B", "KB", "MB", "GB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function clampInt(value, min, max) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
