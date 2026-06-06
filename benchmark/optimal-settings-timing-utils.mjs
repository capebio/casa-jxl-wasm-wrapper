import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { Worker as NodeWorker } from "node:worker_threads";

import initRaw, {
  downscale_rgb,
  process_cr2_with_flags,
  process_dng_with_flags,
  process_orf_with_flags,
  rgb_to_rgba,
} from "../pkg/raw_converter_wasm.js";

export const TEST_ROOT = String.raw`C:\Foo\raw-converter\tests`;
export const GOBABEB_DIR = String.raw`C:\995\2026-02-20 Gobabeb To Windhoek`;
export const TIMING_OUT_DIR = String.raw`C:\Foo\raw-converter-wasm\docs\outputs\timing tests`;

const activeWorkers = new Set();
const OUTPUT_FULL_RGB = 1;
const PROCESS_ARGS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Number.NaN, Number.NaN, 0, 0];

class BrowserLikeWorker {
  #worker;
  #onmessage = null;
  #onerror = null;

  constructor(url, options = {}) {
    this.#worker = new NodeWorker(new URL("../jxl-worker-shim.mjs", import.meta.url), {
      workerData: { url: url instanceof URL ? url.href : String(url), name: options.name ?? "" },
    });
    activeWorkers.add(this);
    this.#worker.on("message", (data) => this.#onmessage?.({ data }));
    this.#worker.on("error", (error) => this.#onerror?.(error));
    this.#worker.on("exit", () => activeWorkers.delete(this));
  }

  postMessage(message, transfer) { this.#worker.postMessage(message, transfer); }
  terminate() {
    activeWorkers.delete(this);
    return this.#worker.terminate();
  }
  set onmessage(handler) { this.#onmessage = handler; }
  get onmessage() { return this.#onmessage; }
  set onerror(handler) { this.#onerror = handler; }
  get onerror() { return this.#onerror; }
}

export function installBrowserLikeWorker() {
  if (typeof globalThis.Worker === "undefined") globalThis.Worker = BrowserLikeWorker;
  globalThis.navigator ??= {};
  globalThis.navigator.hardwareConcurrency ??= 4;
  process.env.JXL_WASM_FORCE_TIER ??= "simd";
}

export async function terminateBrowserLikeWorkers() {
  await Promise.allSettled([...activeWorkers].map((worker) => worker.terminate()));
}

export async function initRawWasm() {
  await initRaw({ module_or_path: readFileSync(new URL("../pkg/raw_converter_wasm_bg.wasm", import.meta.url)) });
}

export function ensureTimingOutDir() {
  if (!existsSync(TIMING_OUT_DIR)) mkdirSync(TIMING_OUT_DIR, { recursive: true });
}

export function exactBuffer(view) {
  if (view instanceof ArrayBuffer) return view;
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view.buffer;
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

export function concatChunks(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function fileType(path) {
  const ext = extname(path).toLowerCase();
  if (ext === ".orf" || ext === ".raw") return "orf";
  if (ext === ".dng") return "dng";
  if (ext === ".cr2") return "cr2";
  return null;
}

export function listRawFiles({ dir = TEST_ROOT, extensions = [".orf", ".raw", ".dng", ".cr2"], limit = 1, largest = false } = {}) {
  if (!existsSync(dir)) return [];
  const allowed = new Set(extensions.map((ext) => ext.toLowerCase()));
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && allowed.has(extname(entry.name).toLowerCase()))
    .map((entry) => {
      const path = join(dir, entry.name);
      return { name: entry.name, path, size: statSync(path).size };
    });
  files.sort(largest ? (a, b) => b.size - a.size : (a, b) => a.name.localeCompare(b.name));
  return files.slice(0, limit);
}

export function selectRawFiles({ primaryDir, fallbackDir = TEST_ROOT, extensions, limit, largest = false }) {
  const primary = primaryDir ? listRawFiles({ dir: primaryDir, extensions, limit, largest }) : [];
  return primary.length ? primary : listRawFiles({ dir: fallbackDir, extensions, limit, largest });
}

function processRaw(type, bytes) {
  if (type === "orf") return process_orf_with_flags(bytes, OUTPUT_FULL_RGB, ...PROCESS_ARGS);
  if (type === "dng") return process_dng_with_flags(bytes, OUTPUT_FULL_RGB, ...PROCESS_ARGS);
  if (type === "cr2") return process_cr2_with_flags(bytes, OUTPUT_FULL_RGB, ...PROCESS_ARGS);
  throw new Error(`unsupported raw type: ${type}`);
}

export function decodeRawToRgba(path, target) {
  const bytes = new Uint8Array(readFileSync(path));
  const rawStart = performance.now();
  const decoded = processRaw(fileType(path), bytes);
  const rawMs = performance.now() - rawStart;
  try {
    const rgbaStart = performance.now();
    const rgb = decoded.take_rgb();
    const srcW = decoded.width;
    const srcH = decoded.height;
    const scale = Math.max(srcW, srcH) > target ? target / Math.max(srcW, srcH) : 1;
    const width = Math.round(srcW * scale);
    const height = Math.round(srcH * scale);
    const rgba = scale < 1
      ? rgb_to_rgba(downscale_rgb(rgb, srcW, srcH, width, height))
      : rgb_to_rgba(rgb);
    return { rgba, width, height, srcW, srcH, rawMs, rgbaMs: performance.now() - rgbaStart };
  } finally {
    decoded.free();
  }
}

export async function encodeJxl(createEncoder, rgba, width, height, options) {
  const encoder = createEncoder({
    format: "rgba8",
    width,
    height,
    hasAlpha: false,
    iccProfile: null,
    exif: null,
    xmp: null,
    distance: null,
    ...options,
  });
  const chunks = [];
  const chunkTask = (async () => {
    for await (const chunk of encoder.chunks()) {
      chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    }
  })();
  const started = performance.now();
  try {
    await encoder.pushPixels(exactBuffer(rgba));
    await encoder.finish();
    await chunkTask;
    return { bytes: concatChunks(chunks), ms: performance.now() - started };
  } finally {
    try { await encoder.dispose(); } catch {}
  }
}

export async function decodeJxl(createDecoder, jxlBytes, options) {
  const decoder = createDecoder({
    format: "rgba8",
    progressionTarget: "final",
    emitEveryPass: false,
    progressiveDetail: "passes",
    downsample: 1,
    preserveIcc: false,
    preserveMetadata: false,
    ...options,
  });
  const started = performance.now();
  let firstMs = null;
  let finalMs = null;
  let passes = 0;
  let pixels = null;
  let width = 0;
  let height = 0;
  let error = null;
  try {
    const eventTask = (async () => {
      for await (const event of decoder.events()) {
        if (event.type === "progress" || event.type === "final") {
          passes++;
          firstMs ??= performance.now() - started;
          pixels = event.pixels ? new Uint8Array(event.pixels) : pixels;
          width = event.info?.width ?? width;
          height = event.info?.height ?? height;
          if (event.type === "final") finalMs = performance.now() - started;
        } else if (event.type === "error") {
          error = `${event.code}: ${event.message}`;
        }
      }
    })();
    await decoder.push(exactBuffer(jxlBytes));
    await decoder.close();
    await eventTask;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    try { await decoder.dispose(); } catch {}
  }
  const elapsed = performance.now() - started;
  return { ms: finalMs ?? elapsed, firstMs: firstMs ?? elapsed, passes, pixels, width, height, error };
}

export function fmtMs(value) {
  if (value == null || !Number.isFinite(value)) return "";
  return value === 0 ? "0" : value.toFixed(3);
}

export function fmtNum(value, digits = 3) {
  if (value == null || !Number.isFinite(value)) return "";
  return value.toFixed(digits);
}

export function stampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function renderTemplateCell(value, previousValue, state, splitter) {
  if (previousValue === value) return '~';
  if (state.active) {
    const expectedPrefix = value.startsWith(state.active.prefix);
    const expectedSuffix = value.endsWith(state.active.suffix);
    if (expectedPrefix && expectedSuffix) {
      const middle = value.slice(state.active.prefix.length, value.length - state.active.suffix.length);
      return `&${middle}@`;
    }
  }
  const template = splitter(value);
  if (template) {
    state.active = template;
    return `${template.prefix}^${template.middle}@${template.suffix}`;
  }
  state.active = null;
  return value;
}

function splitTimeCell(value) {
  const index = value.indexOf(':');
  if (index < 0) return null;
  return { prefix: value.slice(0, index + 1), middle: value.slice(index + 1), suffix: '' };
}

function splitFileCell(value) {
  const match = value.match(/^(.*?)(\d[^.]*)(\.[^.]+)$/);
  if (!match) return null;
  return { prefix: match[1], middle: match[2], suffix: match[3] };
}

export function formatToon({ testName, timestamp, tier, target, quality, effort, notes, columns, records, row }) {
  const timeBase = records.length ? records[0].timestamp.slice(0, 14) : timestamp.slice(0, 14);
  const lines = [
    `TestName: ${testName}`,
    `RunTimestamp: ${timestamp}`,
    "Agent: codex",
    `Tier: ${tier}`,
    `Target: ${target}`,
  ];
  if (quality != null) lines.push(`Quality: ${quality}`);
  if (effort != null) lines.push(`Effort: ${effort}`);
  if (notes) lines.push(`Notes: ${notes}`);
  lines.push(`TimeBase: ${timeBase}`, "", "---");
  lines.push(`runs[${records.length}]{${columns.join("|")}}:`);

  let previous = null;
  const templateState = {};
  for (const col of columns) templateState[col] = { active: null };

  for (const record of records) {
    const values = row(record, timeBase);
    const rendered = values.map((value, index) => {
      const text = String(value);
      if (previous && text === previous[index]) return "~";
      
      const colName = columns[index];
      if (colName === 't') return quoteCell(renderTemplateCell(text, previous?.[index], templateState[colName], splitTimeCell));
      if (colName === 'file') return quoteCell(renderTemplateCell(text, previous?.[index], templateState[colName], splitFileCell));
      
      return quoteCell(text);
    });
    lines.push(`  ${rendered.join(" | ")}`);
    previous = values.map(String);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function quoteCell(value) {
  if (/[|^@&]/.test(value)) return `"${value.replaceAll('"', '\\"')}"`;
  return value;
}
