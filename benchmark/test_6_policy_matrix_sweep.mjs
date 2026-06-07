import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import {
  TEST_ROOT,
  TIMING_OUT_DIR,
  decodeRawToRgba,
  encodeJxl,
  ensureTimingOutDir,
  fmtMs,
  formatToon,
  initRawWasm,
  installBrowserLikeWorker,
  selectRawFiles,
  stampForFile,
  terminateBrowserLikeWorkers,
} from "./optimal-settings-timing-utils.mjs";

installBrowserLikeWorker();
const { createEncoder, detectTier } = await import("../packages/jxl-wasm/dist/index.js");

const TARGET = Number(process.env.TEST6_TARGET ?? "800");
const LIMIT = Math.max(1, Number(process.env.TEST6_LIMIT ?? "1"));
const REPS = Math.max(1, Number(process.env.TEST6_REPS ?? process.env.PM_REPS ?? "1"));
const EFFORTS = parseList(process.env.TEST6_EFFORTS ?? "3,5");
const QUALITIES = parseList(process.env.TEST6_QUALITIES ?? "85,90");
const PROGRESSIVE = parseList(process.env.TEST6_PROGRESSIVE ?? "0,1");
const MODULAR = parseList(process.env.TEST6_MODULAR ?? "-1,0");
const RESAMPLING = parseList(process.env.TEST6_RESAMPLING ?? "1,2");

await initRawWasm();
ensureTimingOutDir();

const tier = detectTier();
const files = selectRawFiles({
  primaryDir: process.env.TEST6_RAW_DIR ?? TEST_ROOT,
  extensions: [".orf", ".raw", ".dng", ".cr2"],
  limit: LIMIT,
});
if (!files.length) throw new Error("test_6 needs at least one raw file");

const records = [];
for (const file of files) {
  const decoded = decodeRawToRgba(file.path, TARGET);
  for (const effort of EFFORTS)
  for (const quality of QUALITIES)
  for (const progressive of PROGRESSIVE)
  for (const modular of MODULAR)
  for (const resampling of RESAMPLING) {
    const times = [];
    let bytes = 0;
    for (let rep = 1; rep <= REPS; rep++) {
      const encoded = await encodeJxl(createEncoder, decoded.rgba, decoded.width, decoded.height, {
        quality,
        effort,
        progressive: Boolean(progressive),
        previewFirst: Boolean(progressive),
        progressiveFlavor: "ac",
        modular,
        resampling,
        brotliEffort: -1,
        chunked: true,
      });
      times.push(encoded.ms);
      bytes = encoded.bytes.byteLength;
    }
    const encodeMs = median(times);
    records.push({
      timestamp: new Date().toISOString(),
      file: basename(file.path),
      effort,
      quality,
      progressive,
      modular,
      resampling,
      reps: REPS,
      rawMs: decoded.rawMs,
      rgbaMs: decoded.rgbaMs,
      encodeMs,
      size: bytes,
    });
    console.log(`[test_6] ${basename(file.path)} e=${effort} q=${quality} p=${progressive} m=${modular} rs=${resampling} enc=${encodeMs.toFixed(0)}ms`);
  }
}

const stamp = stampForFile();
const toon = formatToon({
  testName: "Policy Matrix Sweep (Test_6)",
  timestamp: new Date().toISOString(),
  tier,
  target: TARGET,
  notes: "Targeted jxl-policy matrix: effort, quality, progressive, modular, resampling.",
  columns: ["t", "file", "effort", "quality", "prog", "modular", "resamp", "reps", "raw_ms", "rgba_ms", "encode_ms", "size"],
  records,
  row: (record, timeBase) => [
    record.timestamp.startsWith(timeBase) ? record.timestamp.slice(timeBase.length).replace(/Z$/, "") : record.timestamp,
    record.file,
    record.effort,
    record.quality,
    record.progressive,
    record.modular,
    record.resampling,
    record.reps,
    fmtMs(record.rawMs),
    fmtMs(record.rgbaMs),
    fmtMs(record.encodeMs),
    `${record.size}B`,
  ],
});
const outPath = join(TIMING_OUT_DIR, `${stamp}-test_6_policy_matrix_sweep.toon`);
writeFileSync(outPath, toon, "utf8");
console.log(`[test_6] wrote ${outPath}`);
await terminateBrowserLikeWorkers();

function parseList(value) {
  return String(value).split(",").map(Number).filter(Number.isFinite);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
