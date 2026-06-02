/**
 * Targeted matrix sweep for jxl-policy preset tuning.
 * Sweeps: effort × quality × lossless × progressive × modular × resampling
 * Holds other axes at libjxl defaults to keep cell count bounded.
 *
 * Output: docs/Benchmark results/policy-matrix-<stamp>.csv
 *
 * Usage:
 *   JXL_WASM_FORCE_TIER=simd node benchmark/policy-matrix.mjs
 *
 * Env:
 *   PM_FILE      RAW path (default first .CR2 in test corpus)
 *   PM_REPS      reps per cell (default 2, takes median)
 *   PM_TIMEOUT   per-cell timeout ms (default 60000)
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

const TEST_ROOT = String.raw`C:\Foo\raw-converter\tests`;
const OUT_DIR   = String.raw`C:\Foo\raw-converter-wasm\docs\Benchmark results`;
const REPS      = parseInt(process.env.PM_REPS ?? "2", 10);
const TIMEOUT   = parseInt(process.env.PM_TIMEOUT ?? "60000", 10);

const OUTPUT_FULL_RGB = 1;
const PROCESS_ARGS    = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Number.NaN, Number.NaN, 0, 0];

const SWEEP = {
  effort:      [3, 4, 5],
  quality:     [85, 90, 95],   // lossless=1 ignores quality
  lossless:    [0, 1],
  progressive: [0, 1],
  modular:     [-1, 0, 1],
  resampling:  [1, 2, 4],
};

function fileType(p) {
  const ext = extname(p).toLowerCase();
  if (ext === ".orf" || ext === ".raw") return "orf";
  if (ext === ".dng") return "dng";
  if (ext === ".cr2") return "cr2";
  return null;
}
function processRaw(type, bytes) {
  if (type === "orf") return process_orf_with_flags(bytes, OUTPUT_FULL_RGB, ...PROCESS_ARGS);
  if (type === "dng") return process_dng_with_flags(bytes, OUTPUT_FULL_RGB, ...PROCESS_ARGS);
  if (type === "cr2") return process_cr2_with_flags(bytes, OUTPUT_FULL_RGB, ...PROCESS_ARGS);
  throw new Error(`unsupported: ${type}`);
}
function exactBuffer(view) {
  if (view instanceof ArrayBuffer) return view;
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view.buffer;
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}
const median = a => { const s=[...a].sort((x,y)=>x-y); const m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2; };

async function encodeOnceWithTimeout(rgba, width, height, opts, timeoutMs) {
  let encoder = null;
  let settled = false;
  const run = (async () => {
    const t0 = performance.now();
    encoder = createEncoder(opts);
    const chunks = [];
    const chunkTask = (async () => {
      for await (const c of encoder.chunks()) chunks.push(c instanceof Uint8Array ? c : new Uint8Array(c));
    })();
    await encoder.pushPixels(exactBuffer(rgba));
    await encoder.finish();
    await chunkTask;
    const bytes = chunks.reduce((n, a) => n + a.byteLength, 0);
    return { status: "ok", encodeMs: performance.now() - t0, bytes };
  })();
  const timeout = new Promise(res => setTimeout(() => {
    if (!settled) { settled = true; try { encoder?.dispose?.(); } catch {} res({ status: "timeout", encodeMs: null, bytes: null }); }
  }, timeoutMs));
  const result = await Promise.race([run, timeout]);
  settled = true;
  try { await encoder?.dispose?.(); } catch {}
  return result;
}

async function main() {
  await initRaw({ module_or_path: readFileSync(new URL("../pkg/raw_converter_wasm_bg.wasm", import.meta.url)) });
  const tier = detectTier();

  let path = process.env.PM_FILE;
  if (!path) {
    const cands = readdirSync(TEST_ROOT, { withFileTypes: true })
      .filter(e => e.isFile() && fileType(e.name))
      .map(e => join(TEST_ROOT, e.name))
      .sort();
    if (!cands.length) { console.error("no raw files"); process.exit(1); }
    path = cands[0];
  }
  console.log(`[policy-matrix] tier=${tier} reps=${REPS} timeout=${TIMEOUT}ms`);
  console.log(`[policy-matrix] file: ${basename(path)}`);

  const bytes = new Uint8Array(readFileSync(path));
  const decoded = processRaw(fileType(path), bytes);
  const rgba = rgb_to_rgba(decoded.take_rgb());
  const { width, height } = decoded;
  console.log(`[policy-matrix] decoded ${width}x${height} (${(width*height*4/1024/1024).toFixed(1)} MB RGBA)\n`);

  // Warmup
  await encodeOnceWithTimeout(new Uint8Array(64*64*4), 64, 64, {
    format:"rgba8", width:64, height:64, hasAlpha:true, distance:null, quality:85, effort:3, modular:-1, brotliEffort:-1,
  }, 30000);

  // Cell count
  const total = SWEEP.effort.length * SWEEP.quality.length * SWEEP.lossless.length
              * SWEEP.progressive.length * SWEEP.modular.length * SWEEP.resampling.length;
  console.log(`[policy-matrix] ${total} cells × ${REPS} reps\n`);

  const rows = [];
  let done = 0;
  const tStart = performance.now();

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const csvPath = join(OUT_DIR, `policy-matrix-${stamp}.csv`);
  const csvHeader = "effort,quality,lossless,progressive,modular,resampling,encodeMs,bytes,status";
  writeFileSync(csvPath, csvHeader + "\n");

  for (const effort of SWEEP.effort)
  for (const quality of SWEEP.quality)
  for (const lossless of SWEEP.lossless) {
    if (lossless === 1 && quality !== SWEEP.quality[0]) continue; // collapse duplicate lossless cells
  for (const progressive of SWEEP.progressive)
  for (const modular of SWEEP.modular)
  for (const resampling of SWEEP.resampling) {
    const opts = {
      format: "rgba8", width, height, hasAlpha: true,
      distance: lossless ? 0 : null,
      quality:  lossless ? null : quality,
      effort, progressive: !!progressive, previewFirst: !!progressive,
      modular, brotliEffort: -1, resampling,
    };
    const times = [];
    let lastBytes = 0;
    let status = "ok";
    for (let r = 0; r < REPS; r++) {
      const res = await encodeOnceWithTimeout(rgba, width, height, opts, TIMEOUT);
      if (res.status !== "ok") { status = res.status; break; }
      times.push(res.encodeMs);
      lastBytes = res.bytes;
    }
    const encodeMs = status === "ok" ? median(times) : null;
    const bytesOut = status === "ok" ? lastBytes : null;
    rows.push({ effort, quality, lossless, progressive, modular, resampling, encodeMs, bytes: bytesOut, status });
    done++;
    const elapsed = (performance.now() - tStart) / 1000;
    const eta = elapsed / done * (total - done);
    process.stdout.write(`\r[${done}/${total}] e=${effort} q=${lossless?"LL":quality} prog=${progressive} mod=${String(modular).padStart(2)} rs=${resampling}  ${encodeMs?encodeMs.toFixed(0).padStart(5):" tmo "}ms  ${(bytesOut/1024).toFixed(0).padStart(5)}KB  elapsed=${elapsed.toFixed(0)}s eta=${eta.toFixed(0)}s         `);
    // Append to CSV incrementally so we keep progress on crash
    const line = `${effort},${quality},${lossless},${progressive},${modular},${resampling},${encodeMs ?? ""},${bytesOut ?? ""},${status}\n`;
    writeFileSync(csvPath, line, { flag: "a" });
  }}
  console.log(`\n\n[policy-matrix] complete: ${done} cells in ${((performance.now()-tStart)/1000).toFixed(0)}s`);
  console.log(`[policy-matrix] csv: ${csvPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
