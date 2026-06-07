import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import {
  GOBABEB_DIR,
  TIMING_OUT_DIR,
  decodeJxl,
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
const { createDecoder, createEncoder, detectTier } = await import("../packages/jxl-wasm/dist/index.js");

const TARGET = Number(process.env.TEST3_TARGET ?? process.env.EFFORT_TARGET ?? "1600");
const QUALITY = Number(process.env.TEST3_QUALITY ?? process.env.EFFORT_QUALITY ?? "85");
const LIMIT = Math.max(1, Number(process.env.TEST3_LIMIT ?? process.env.EFFORT_LIMIT ?? "1"));
const EFFORTS = String(process.env.TEST3_EFFORTS ?? "3,5,7").split(",").map(Number).filter(Number.isFinite);

await initRawWasm();
ensureTimingOutDir();

const tier = detectTier();
const files = selectRawFiles({
  primaryDir: process.env.TEST3_RAW_DIR ?? GOBABEB_DIR,
  extensions: [".orf"],
  limit: LIMIT,
  largest: true,
});
if (!files.length) throw new Error("test_3 needs at least one ORF file");

const records = [];
for (const file of files) {
  const decoded = decodeRawToRgba(file.path, TARGET);
  for (const effort of EFFORTS) {
    const encoded = await encodeJxl(createEncoder, decoded.rgba, decoded.width, decoded.height, {
      quality: QUALITY,
      effort,
      progressive: true,
      progressiveFlavor: "ac",
      previewFirst: false,
      chunked: true,
    });
    const full = await decodeJxl(createDecoder, encoded.bytes, {
      emitEveryPass: true,
      progressiveDetail: "passes",
    });
    records.push({
      timestamp: new Date().toISOString(),
      file: basename(file.path),
      effort,
      rawMs: decoded.rawMs,
      rgbaMs: decoded.rgbaMs,
      encodeMs: encoded.ms,
      firstMs: full.firstMs,
      finalMs: full.ms,
      passes: full.passes,
      size: encoded.bytes.byteLength,
    });
    console.log(`[test_3] ${basename(file.path)} e=${effort} enc=${encoded.ms.toFixed(0)}ms first=${full.firstMs.toFixed(0)}ms final=${full.ms.toFixed(0)}ms passes=${full.passes}`);
  }
}

const stamp = stampForFile();
const toon = formatToon({
  testName: "Progressive Testing - Effort Sweep (Test_3)",
  timestamp: new Date().toISOString(),
  tier,
  target: TARGET,
  quality: QUALITY,
  effort: EFFORTS.join(","),
  notes: "Measure effort vs encode time, first pass arrival, final decode, pass count.",
  columns: ["t", "file", "effort", "raw_ms", "rgba_ms", "encode_ms", "first_ms", "final_ms", "passes", "size"],
  records,
  row: (record, timeBase) => [
    record.timestamp.startsWith(timeBase) ? record.timestamp.slice(timeBase.length).replace(/Z$/, "") : record.timestamp,
    record.file,
    record.effort,
    fmtMs(record.rawMs),
    fmtMs(record.rgbaMs),
    fmtMs(record.encodeMs),
    fmtMs(record.firstMs),
    fmtMs(record.finalMs),
    record.passes,
    `${record.size}B`,
  ],
});
const outPath = join(TIMING_OUT_DIR, `${stamp}-test_3_progressive_effort_sweep.toon`);
writeFileSync(outPath, toon, "utf8");
console.log(`[test_3] wrote ${outPath}`);
await terminateBrowserLikeWorkers();
