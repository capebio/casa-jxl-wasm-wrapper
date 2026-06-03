/**
 * Non-client progressive byte benchmark.
 *
 * Usage:
 *   PBB_LIMIT=1 PBB_TARGET=300 node benchmark/progressive-byte-benchmark.mjs
 *
 * Reads Gobabeb ORFs, encodes target-size JXL with the progressive web preset,
 * streams cumulative byte cutoffs, and writes JSON under docs/Benchmark results.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { performance } from "node:perf_hooks";

import initRaw, {
  downscale_rgb,
  process_orf_with_flags,
  rgb_to_rgba,
} from "../pkg/raw_converter_wasm.js";
import { buildByteCutoffPlan } from "../web/jxl-byte-cutoff-probe.js";
import { createProgressiveWebPreset, createSidecarTargetPlan } from "../web/jxl-progressive-best-preset.js";
import { classifyByteCutoffFrame, summarizeByteCutoffResults } from "../web/jxl-progressive-byte-metrics.js";

const GOBABEB_DIR = String.raw`C:\995\2026-02-20 Gobabeb To Windhoek`;
const OUT_DIR = String.raw`C:\Foo\raw-converter-wasm\docs\Benchmark results`;
const OUTPUT_FULL_RGB = 1;
const PROCESS_ARGS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Number.NaN, Number.NaN, 0, 0];

const LIMIT = clampInt(process.env.PBB_LIMIT ?? "3", 1, 50);
const TARGET = process.env.PBB_TARGET ?? "800";
const QUALITY = clampInt(process.env.PBB_QUALITY ?? "85", 1, 100);
const DETAIL = process.env.PBB_DETAIL ?? "passes";

let createDecoder;
let createEncoder;
let detectTier;

async function main() {
  if (typeof globalThis.Worker === "undefined" && !process.env.JXL_WASM_FORCE_TIER) {
    process.env.JXL_WASM_FORCE_TIER = "simd";
  }
  ({ createDecoder, createEncoder, detectTier } = await import("../packages/jxl-wasm/dist/index.js"));
  await initRaw({ module_or_path: readFileSync(new URL("../pkg/raw_converter_wasm_bg.wasm", import.meta.url)) });
  const tier = detectTier();
  const files = selectFiles();
  if (!files.length) throw new Error(`No ORFs found in ${GOBABEB_DIR}`);
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  console.log(`[progressive-byte] tier=${tier} files=${files.length} target=${TARGET} quality=${QUALITY} detail=${DETAIL}`);
  const results = [];

  for (const file of files) {
    console.log(`[progressive-byte] ${basename(file)}`);
    const raw = new Uint8Array(readFileSync(file));
    const decoded = process_orf_with_flags(raw, OUTPUT_FULL_RGB, ...PROCESS_ARGS);
    try {
      const rgb = decoded.take_rgb();
      const source = { width: decoded.width, height: decoded.height, rgb };
      const variantTargets = createSidecarTargetPlan(TARGET === "full" ? "full" : Number(TARGET));
      const variants = [];
      for (const variantTarget of variantTargets) {
        const sidecar = variantTargets.length > 1 && variantTarget !== variantTargets.at(-1);
        const label = sidecar ? `sidecar-${variantTarget}` : `target-${variantTarget}`;
        const preset = createProgressiveWebPreset({
          width: source.width,
          height: source.height,
          targetLongEdge: variantTarget,
          quality: QUALITY,
          progressiveDetail: DETAIL,
        });
        const rgba = makeTargetRgba(source, preset.target.width, preset.target.height);
        const tEncode = performance.now();
        const jxlBytes = await encodeTarget(rgba, preset.encode);
        const encodeMs = performance.now() - tEncode;
        const plan = buildByteCutoffPlan(jxlBytes.byteLength, preset.byteCutoffs);
        const streamed = await streamDecodeCutoffs(jxlBytes, plan, preset.decode);
        const cutoffs = streamed.cutoffs.map((cutoff) => classifyByteCutoffFrame(cutoff));
        const summary = summarizeByteCutoffResults(cutoffs, jxlBytes.byteLength);
        variants.push({
          label,
          sidecar,
          target: preset.target,
          encode: preset.encode,
          encodeMs,
          jxlBytes: jxlBytes.byteLength,
          summary,
          cutoffs,
        });
        const useful = summary.usefulEarlyPaint ? "early=yes" : "early=no";
        console.log(`  ${label} jxl=${fmtBytes(jxlBytes.byteLength)} encode=${encodeMs.toFixed(0)}ms first=${fmtBytes(summary.firstPaintBytes)} preview=${fmtBytes(summary.previewBytes)} paints=${summary.paintedCutoffs} ${useful}`);
      }
      const targetVariant = variants.at(-1);
      const firstVisible = variants.find((variant) => variant.summary.firstPaintBytes != null) ?? targetVariant;
      const sidecarFirst = variants.find((variant) => variant.sidecar && variant.summary.firstPaintBytes != null) ?? null;
      console.log(`  effective first-visible=${fmtBytes(firstVisible?.summary.firstPaintBytes)} sidecar-first=${fmtBytes(sidecarFirst?.summary.firstPaintBytes)} target-progressive=${targetVariant?.summary.usefulEarlyPaint ? "yes" : "no"}`);
      results.push({
        file: basename(file),
        rawBytes: raw.byteLength,
        source: { width: source.width, height: source.height },
        variants,
        target: targetVariant?.target ?? null,
        summary: targetVariant?.summary ?? null,
        targetUsefulEarlyPaint: targetVariant?.summary.usefulEarlyPaint ?? false,
        sidecarFirstVisibleBytes: sidecarFirst?.summary.firstPaintBytes ?? null,
        firstVisibleBytes: firstVisible?.summary.firstPaintBytes ?? null,
      });
    } finally {
      decoded.free();
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = join(OUT_DIR, `progressive-byte-benchmark-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify({
    exportedAt: new Date().toISOString(),
    generator: "progressive-byte-benchmark",
    tier,
    target: TARGET,
    quality: QUALITY,
    detail: DETAIL,
    results,
  }, null, 2));
  console.log(`[progressive-byte] wrote ${outPath}`);
}

function selectFiles() {
  return readdirSync(GOBABEB_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".orf")
    .map((entry) => {
      const path = join(GOBABEB_DIR, entry.name);
      return { path, size: statSync(path).size };
    })
    .sort((a, b) => b.size - a.size)
    .slice(0, LIMIT)
    .map((entry) => entry.path);
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

async function streamDecodeCutoffs(jxlBytes, plan, decodeOptions) {
  const decoder = createDecoder(decodeOptions);
  const cutoffs = plan.map((entry) => ({ entry, bytes: entry.bytes, events: [], error: null }));
  const byBytes = new Map(cutoffs.map((cutoff) => [cutoff.bytes, cutoff]));
  let currentEntry = plan[0] ?? null;
  let error = null;
  try {
    const eventTask = (async () => {
      for await (const event of decoder.events()) {
        if (event.type === "progress" || event.type === "final") {
          const cutoff = byBytes.get(currentEntry?.bytes) ?? cutoffs.at(-1);
          if (cutoff) cutoff.events.push(event);
        }
        if (event.type === "error") throw new Error(`${event.code}: ${event.message}`);
      }
    })();
    let offset = 0;
    for (const entry of plan) {
      if (entry.bytes <= offset) continue;
      currentEntry = entry;
      await decoder.push(exactBuffer(jxlBytes.subarray(offset, entry.bytes)));
      offset = entry.bytes;
      await waitForStreamEvents();
    }
    await decoder.close();
    await eventTask;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    await decoder.dispose();
  }
  if (error) {
    for (const cutoff of cutoffs) {
      if (cutoff.events.length === 0) cutoff.error = error;
    }
  }
  return { cutoffs, error };
}

function exactBuffer(view) {
  if (view instanceof ArrayBuffer) return view;
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view.buffer;
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

function concatChunks(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
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

function waitForStreamEvents() {
  return new Promise((resolve) => setImmediate(resolve));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
