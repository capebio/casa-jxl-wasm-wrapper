/**
 * JPEG -> JXL streaming progressive bench.
 * Mirror of progressive-flag-matrix.mjs but with JPEG decode (sharp) as the
 * pixel source. Sweeps the same flag matrix x effort {3, 5} and writes
 * docs/Benchmark results/jpeg-progressive-stream-<ts>.json.
 *
 * Env:
 *   JPEG_DIR     JPEG source dir (default Gobabeb JPEG subdir)
 *   JPS_LIMIT    files to process (default 1)
 *   JPS_START    skip first N files (default 0)
 *   JPS_TARGET   target long edge px or 'full' (default 1600)
 *   JPS_QUALITY  encode quality 1..100 (default 85)
 *   JPS_DETAIL   progressiveDetail (default passes)
 *   JPS_WAIT_MS  wait between pushes (default 0)
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';

import { buildByteCutoffPlan } from '../web/jxl-byte-cutoff-probe.js';
import { createProgressiveWebPreset } from '../web/jxl-progressive-best-preset.js';
import { classifyByteCutoffFrame, summarizeByteCutoffResults } from '../web/jxl-progressive-byte-metrics.js';
import { exactBuffer, concatChunks, streamDecodeCutoffs, computeQualitySeries } from './_progressive-stream-helper.mjs';

const JPEG_DIR = process.env.JPEG_DIR ?? String.raw`C:\995\2026-02-20 Gobabeb To Windhoek\JPEG`;
const OUT_DIR = String.raw`C:\Foo\raw-converter-wasm\docs\Benchmark results`;
const LIMIT = clampInt(process.env.JPS_LIMIT ?? '1', 1, 100);
const START = clampInt(process.env.JPS_START ?? '0', 0, 1000);
const TARGET = process.env.JPS_TARGET ?? '1600';
const QUALITY = clampInt(process.env.JPS_QUALITY ?? '85', 1, 100);
const DETAIL = process.env.JPS_DETAIL ?? 'passes';
const WAIT_MS = clampInt(process.env.JPS_WAIT_MS ?? '0', 0, 1000);

const MATRIX_CASES = Object.freeze([
  { name: 'dc1-only',       progressiveDc: 1, progressiveAc: 0, qProgressiveAc: 0, groupOrder: 1 },
  { name: 'dc2-only',       progressiveDc: 2, progressiveAc: 0, qProgressiveAc: 0, groupOrder: 1 },
  { name: 'dc2-ac-only',    progressiveDc: 2, progressiveAc: 1, qProgressiveAc: 0, groupOrder: 1 },
  { name: 'dc2-q-only',     progressiveDc: 2, progressiveAc: 0, qProgressiveAc: 1, groupOrder: 1 },
  { name: 'dc2-ac-q',       progressiveDc: 2, progressiveAc: 1, qProgressiveAc: 1, groupOrder: 1 },
  { name: 'dc2-q-scanline', progressiveDc: 2, progressiveAc: 0, qProgressiveAc: 1, groupOrder: 0 },
  { name: 'sneyers',        progressiveDc: 2, progressiveAc: 1, qProgressiveAc: 1, groupOrder: 1, decodingSpeed: 0 },
]);

const EFFORT_SWEEP = Object.freeze([3, 5]);

let createDecoder;
let createEncoder;
let detectTier;

export async function runJpegMatrix() {
  if (typeof globalThis.Worker === 'undefined' && !process.env.JXL_WASM_FORCE_TIER) {
    process.env.JXL_WASM_FORCE_TIER = 'simd';
  }
  ({ createDecoder, createEncoder, detectTier } = await import('../packages/jxl-wasm/dist/index.js'));
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  const files = selectFiles();
  if (files.length === 0) throw new Error(`No JPEGs found in ${JPEG_DIR}`);
  const tier = detectTier();
  console.log(`[jpeg-progressive-stream] tier=${tier} files=${files.length} target=${TARGET} quality=${QUALITY} detail=${DETAIL} wait=${WAIT_MS}ms`);

  const results = [];
  for (const file of files) {
    console.log(`[jpeg-progressive-stream] ${basename(file)}`);
    const jpegBytes = readFileSync(file);
    const { data, info } = await sharp(jpegBytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const source = { width: info.width, height: info.height, rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
    const targetLongEdge = TARGET === 'full' ? 'full' : Number(TARGET);
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
          progressiveFlavor: 'dc',
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
        cases.push({ effort, ...matrixCase, name: caseName, encodeMs, jxlBytes: jxlBytes.byteLength, summary, cutoffs, qualitySeries });
        console.log(`  ${caseName.padEnd(22)} jxl=${fmtBytes(jxlBytes.byteLength)} first=${fmtBytes(summary.firstPaintBytes)} recog=${fmtBytes(summary.firstRecognizableBytes)} preview=${fmtBytes(summary.previewBytes)} paints=${summary.paintedCutoffs} mono=${summary.monotone} finalPsnr=${summary.finalPsnr?.toFixed(1)}`);
      }
    }
    results.push({
      file: basename(file),
      jpegBytes: jpegBytes.byteLength,
      source: { width: source.width, height: source.height },
      target: basePreset.target,
      cases,
    });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = join(OUT_DIR, `jpeg-progressive-stream-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify({
    exportedAt: new Date().toISOString(),
    generator: 'jpeg-progressive-stream',
    tier,
    target: TARGET,
    quality: QUALITY,
    detail: DETAIL,
    matrixCases: MATRIX_CASES,
    effortSweep: EFFORT_SWEEP,
    results,
  }, null, 2));
  console.log(`[jpeg-progressive-stream] wrote ${outPath}`);
  return results;
}

function selectFiles() {
  let entries;
  try {
    entries = readdirSync(JPEG_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && ['.jpg', '.jpeg'].includes(extname(entry.name).toLowerCase()))
      .map((entry) => {
        const path = join(JPEG_DIR, entry.name);
        return { path, size: statSync(path).size };
      })
      .sort((a, b) => a.size - b.size);
  } catch {
    return [];
  }
  return entries.slice(START, START + LIMIT).map((entry) => entry.path);
}

function makeTargetRgba(source, width, height) {
  if (source.width === width && source.height === height) return source.rgba;
  return downscaleRgba(source.rgba, source.width, source.height, width, height);
}

function downscaleRgba(src, srcW, srcH, dstW, dstH) {
  const out = new Uint8Array(dstW * dstH * 4);
  const xRatio = srcW / dstW;
  const yRatio = srcH / dstH;
  for (let y = 0; y < dstH; y++) {
    const sy = Math.min(srcH - 1, Math.floor(y * yRatio));
    for (let x = 0; x < dstW; x++) {
      const sx = Math.min(srcW - 1, Math.floor(x * xRatio));
      const si = (sy * srcW + sx) * 4;
      const di = (y * dstW + x) * 4;
      out[di] = src[si];
      out[di + 1] = src[si + 1];
      out[di + 2] = src[si + 2];
      out[di + 3] = src[si + 3];
    }
  }
  return out;
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
  if (!Number.isFinite(n)) return '--';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function clampInt(value, min, max) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runJpegMatrix().catch((error) => { console.error(error); process.exit(1); });
}
