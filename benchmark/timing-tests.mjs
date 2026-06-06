import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { performance } from 'node:perf_hooks';

import initRaw, {
  process_cr2_with_flags,
  process_dng_with_flags,
  process_orf_with_flags,
  rgb_to_rgba,
} from '../pkg/raw_converter_wasm.js';
import { Worker as NodeWorker } from 'node:worker_threads';
import { createEncoder, detectTier } from '../packages/jxl-wasm/dist/index.js';
import sharp from 'sharp';

const RAW_ROOT = String.raw`C:\995\2026-02-20 Gobabeb To Windhoek`;
const RAW_JPEG_ROOT = join(RAW_ROOT, 'JPEG');
const OUT_DIR = String.raw`C:\Foo\raw-converter-wasm\docs\outputs\timing tests`;
const OUTPUT_FULL_RGB = 1;
const PROCESS_ARGS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Number.NaN, Number.NaN, 0, 0];

const RAW_LIMIT = Math.max(1, Number(process.env.TIMING_RAW_LIMIT ?? '2'));
const JPEG_LIMIT = Math.max(1, Number(process.env.TIMING_JPEG_LIMIT ?? '2'));
const TARGET = Number(process.env.TIMING_TARGET ?? '1600');
const QUALITY = Number(process.env.TIMING_QUALITY ?? '85');
const EFFORTS = (process.env.TIMING_EFFORTS ?? '3,5').split(',').map((n) => Number(n.trim())).filter(Number.isFinite);
const MODES = (process.env.TIMING_MODES ?? 'std,std+chunked,std+modular,std+chunked+modular').split(',').map((s) => s.trim()).filter(Boolean);
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

async function encodeJxl(rgba, width, height, options) {
  const started = performance.now();
  const encoder = createEncoder({
    format: 'rgba8',
    width,
    height,
    hasAlpha: true,
    distance: 1.0,
    quality: QUALITY,
    effort: options.effort,
    progressive: false,
    previewFirst: false,
    chunked: options.chunked,
    modular: options.modular,
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
  const bytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  return { encodeMs: performance.now() - started, jxlBytes: bytes };
}

function toonRunString(run) {
  const lines = [];
  const timeBase = run.records.length ? run.records[0].timestamp.slice(0, 14) : run.timestamp.slice(0, 14);
  lines.push(`TestName: ${run.test}`);
  lines.push(`RunTimestamp: ${run.timestamp}`);
  lines.push(`Agent: ${run.agent}`);
  lines.push(`Tier: ${run.tier}`);
  lines.push(`Source: ${run.source}`);
  lines.push(`RawLimit: ${run.raw_limit}`);
  lines.push(`JpegLimit: ${run.jpeg_limit}`);
  lines.push(`Target: ${run.target}`);
  lines.push(`Quality: ${run.quality}`);
  lines.push(`Efforts: ${run.efforts.join(', ')}`);
  lines.push(`Modes: ${run.modes.join(', ')}`);
  lines.push(`TimeBase: ${timeBase}`);
  lines.push('');
  lines.push('---');
  lines.push(`runs[${run.records.length}]{t|mode|effort|file|raw_ms|rgba_ms|encode_ms|total_ms|size}:`);
  let previous = null;
  const templateState = {
    t: null,
    mode: null,
    file: null,
  };
  for (const record of run.records) {
    const full = {
      t: record.timestamp.startsWith(timeBase) ? record.timestamp.slice(timeBase.length).replace(/Z$/, '') : record.timestamp,
      mode: record.permutation.mode,
      effort: String(record.permutation.effort),
      file: record.file,
      raw_ms: formatTiming(record.metrics.raw_ms),
      rgba_ms: formatTiming(record.metrics.rgba_ms),
      encode_ms: formatTiming(record.metrics.encode_ms),
      total_ms: formatTiming(record.metrics.total_ms),
      size: `${record.metrics.jxl_bytes}B`,
    };
    const row = {
      t: renderTemplateCell('t', full.t, previous?.t, templateState, splitTimeCell),
      mode: renderTemplateCell('mode', full.mode, previous?.mode, templateState, splitModeCell),
      effort: full.effort,
      file: renderTemplateCell('file', full.file, previous?.file, templateState, splitFileCell),
      raw_ms: full.raw_ms,
      rgba_ms: full.rgba_ms,
      encode_ms: full.encode_ms,
      total_ms: full.total_ms,
      size: full.size,
    };
    const values = ['t', 'mode', 'effort', 'file', 'raw_ms', 'rgba_ms', 'encode_ms', 'total_ms', 'size']
      .map((key) => previous && full[key] === previous[key] && key !== 'size' ? '~' : row[key]);
    lines.push(`  ${values.join(' | ')}`);
    previous = full;
  }
  if (run.records.length) lines.push('');
  const totalEncode = run.records.reduce((sum, record) => sum + record.metrics.encode_ms, 0);
  const totalTotal = run.records.reduce((sum, record) => sum + record.metrics.total_ms, 0);
  lines.push('# Aggregates');
  lines.push(`TotalRecords: ${run.records.length}`);
  lines.push(`TotalEncodeMs: ${totalEncode.toFixed(3)}`);
  lines.push(`TotalWallMs: ${totalTotal.toFixed(3)}`);
  return lines.join('\n') + '\n';
}

function formatTiming(value) {
  return value === 0 ? '0' : value.toFixed(3);
}

function renderTemplateCell(key, value, previousValue, state, splitter) {
  if (previousValue === value) return '~';
  const active = state[key];
  if (active) {
    const expectedPrefix = value.startsWith(active.prefix);
    const expectedSuffix = value.endsWith(active.suffix);
    if (expectedPrefix && expectedSuffix) {
      const middle = value.slice(active.prefix.length, value.length - active.suffix.length);
      return `&${middle}@`;
    }
  }
  const template = splitter(value);
  if (template) {
    state[key] = template;
    return `${template.prefix}^${template.middle}@${template.suffix}`;
  }
  state[key] = null;
  return value;
}

function splitTimeCell(value) {
  const index = value.indexOf(':');
  if (index < 0) return null;
  return {
    prefix: value.slice(0, index + 1),
    middle: value.slice(index + 1),
    suffix: '',
  };
}

function splitModeCell(value) {
  if (!value.startsWith('std')) return null;
  return {
    prefix: 'std',
    middle: value.slice('std'.length),
    suffix: '',
  };
}

function splitFileCell(value) {
  const match = value.match(/^(.*?)(\d[^.]*)(\.[^.]+)$/);
  if (!match) return null;
  return {
    prefix: match[1],
    middle: match[2],
    suffix: match[3],
  };
}

function selectFiles(root, limit, formats) {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && formats.includes(extname(entry.name).toLowerCase()))
    .map((entry) => join(root, entry.name))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, limit);
}

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

  const rawFiles = selectFiles(RAW_ROOT, RAW_LIMIT, ['.orf', '.raw', '.dng', '.cr2']);
  const jpegFiles = selectFiles(RAW_JPEG_ROOT, JPEG_LIMIT, ['.jpg', '.jpeg']);
  const rawTestName = 'raw-permutation';
  const jpegTestName = 'jpeg-permutation';
  const records = [];

  console.log(`[timing-tests] tier=${tier} raw=${rawFiles.length} jpeg=${jpegFiles.length} timestamp=${TIMESTAMP}`);

  for (const path of rawFiles) {
    const bytes = new Uint8Array(readFileSync(path));
    const type = fileType(path);
    const rawStarted = performance.now();
    const result = processRaw(type, bytes);
    try {
      const rawMs = performance.now() - rawStarted;
      const rgbStarted = performance.now();
      const rgba = rgb_to_rgba(result.take_rgb());
      const rgbaMs = performance.now() - rgbStarted;
      for (const effort of EFFORTS) {
        for (const mode of MODES) {
          const permutation = {
            mode,
            effort,
            quality: QUALITY,
            chunked: mode.includes('chunked'),
            modular: mode.includes('modular'),
          };
          const encode = await encodeJxl(rgba, result.width, result.height, permutation);
          const totalMs = rawMs + rgbaMs + encode.encodeMs;
          const record = {
            timestamp: new Date().toISOString(),
            test: rawTestName,
            file: basename(path),
            source: 'raw',
            tier,
            permutation,
            metrics: {
              raw_ms: rawMs,
              rgba_ms: rgbaMs,
              encode_ms: encode.encodeMs,
              jxl_bytes: encode.jxlBytes,
              total_ms: totalMs,
            },
          };
          records.push(record);
        }
      }
    } finally {
      result.free();
    }
  }

  for (const path of jpegFiles) {
    const jpegBytes = readFileSync(path);
    const { data, info } = await sharp(jpegBytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const rgba = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    for (const effort of EFFORTS) {
      for (const mode of MODES) {
        const permutation = {
          mode,
          effort,
          quality: QUALITY,
          chunked: mode.includes('chunked'),
          modular: mode.includes('modular'),
        };
        const encode = await encodeJxl(rgba, info.width, info.height, permutation);
        const record = {
          timestamp: new Date().toISOString(),
          test: jpegTestName,
          file: basename(path),
          source: 'jpeg',
          tier,
          permutation,
          metrics: {
            raw_ms: 0,
            rgba_ms: 0,
            encode_ms: encode.encodeMs,
            jxl_bytes: encode.jxlBytes,
            total_ms: encode.encodeMs,
          },
        };
        records.push(record);
      }
    }
  }

  const outPath = join(OUT_DIR, `${TIMESTAMP}-timing-tests.toon`);
  writeFileSync(outPath, toonRunString({
    timestamp: TIMESTAMP,
    test: 'timing-tests',
    agent: 'codex',
    tier,
    source: rawFiles.length && jpegFiles.length ? 'mixed' : rawFiles.length ? 'raw' : 'jpeg',
    raw_limit: rawFiles.length,
    jpeg_limit: jpegFiles.length,
    target: TARGET,
    quality: QUALITY,
    efforts: EFFORTS,
    modes: MODES,
    records,
  }), 'utf8');
  console.log(`[timing-tests] wrote ${basename(outPath)}`);
}

await main();
