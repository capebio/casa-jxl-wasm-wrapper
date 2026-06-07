import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";

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
} from "./optimal-settings-timing-utils.mjs";

installBrowserLikeWorker();
const { createDecoder, createEncoder, detectTier } = await import("../packages/jxl-wasm/dist/index.js");

const TARGET = Number(process.env.TEST7_TARGET ?? process.env.P3_TARGET ?? "1600");
const QUALITY = Number(process.env.TEST7_QUALITY ?? process.env.P3_QUALITY ?? "85");
const LIMIT = Math.max(1, Number(process.env.TEST7_LIMIT ?? process.env.P3_LIMIT ?? "5"));
const EFFORT = Number(process.env.TEST7_EFFORT ?? process.env.P3_EFFORT ?? "3");

await initRawWasm();
ensureTimingOutDir();

const tier = detectTier();
const files = selectRawFiles({
  primaryDir: process.env.TEST7_RAW_DIR ?? GOBABEB_DIR,
  extensions: [".orf"],
  limit: LIMIT,
  largest: true,
});
if (!files.length) throw new Error("test_7 needs at least one ORF file");

const records = [];
for (const file of files) {
  const decoded = decodeRawToRgba(file.path, TARGET);
  
  const encoded = await encodeJxl(createEncoder, decoded.rgba, decoded.width, decoded.height, {
    quality: QUALITY,
    effort: EFFORT,
    progressive: true,
    progressiveFlavor: "ac",
    previewFirst: false,
    chunked: true,
  });

  const fullDec = await decodeJxl(createDecoder, encoded.bytes, {
    emitEveryPass: true,
    progressiveDetail: "passes",
    downsample: 1,
  });

  const previewDec = await decodeJxl(createDecoder, encoded.bytes, {
    emitEveryPass: false,
    progressiveDetail: "dc",
    downsample: 2,
  });

  const ds2Dec = await decodeJxl(createDecoder, encoded.bytes, {
    emitEveryPass: false,
    progressiveDetail: "dc",
    downsample: 2,
  });

  const region = {
    x: Math.floor(fullDec.width * 0.25),
    y: Math.floor(fullDec.height * 0.25),
    w: Math.floor(fullDec.width * 0.5),
    h: Math.floor(fullDec.height * 0.5),
  };

  const regionDec = await decodeJxl(createDecoder, encoded.bytes, {
    emitEveryPass: false,
    progressiveDetail: "dc",
    downsample: 1,
    region,
  });

  const regionDs2Dec = await decodeJxl(createDecoder, encoded.bytes, {
    emitEveryPass: false,
    progressiveDetail: "dc",
    downsample: 2,
    region,
  });

  records.push({
    timestamp: new Date().toISOString(),
    file: basename(file.path),
    encodeMs: encoded.ms,
    passes: fullDec.passes,
    fullFirstMs: fullDec.firstMs,
    fullFinalMs: fullDec.ms,
    prevDcDs2Ms: previewDec.ms,
    ds2Ms: ds2Dec.ms,
    reg50Ms: regionDec.ms,
    regDs2Ms: regionDs2Dec.ms,
    size: encoded.bytes.byteLength,
  });

  console.log(`[test_7] ${basename(file.path)} enc=${encoded.ms.toFixed(0)}ms first=${fullDec.firstMs.toFixed(0)}ms final=${fullDec.ms.toFixed(0)}ms passes=${fullDec.passes}`);
}

const stamp = stampForFile();
const toon = formatToon({
  testName: "P3.1 Feature Benchmark (Test_7)",
  timestamp: new Date().toISOString(),
  tier,
  target: TARGET,
  quality: QUALITY,
  effort: EFFORT,
  notes: "previewFirst, region/downsample extraction.",
  columns: ["t", "file", "encode_ms", "passes", "full_first_ms", "full_final_ms", "prev_dc_ds2_ms", "ds2_ms", "reg50_ms", "reg_ds2_ms", "size"],
  records,
  row: (record, timeBase) => [
    record.timestamp.startsWith(timeBase) ? record.timestamp.slice(timeBase.length).replace(/Z$/, "") : record.timestamp,
    record.file,
    fmtMs(record.encodeMs),
    record.passes,
    fmtMs(record.fullFirstMs),
    fmtMs(record.fullFinalMs),
    fmtMs(record.prevDcDs2Ms),
    fmtMs(record.ds2Ms),
    fmtMs(record.reg50Ms),
    fmtMs(record.regDs2Ms),
    `${record.size}B`,
  ],
});
const outPath = join(TIMING_OUT_DIR, `${stamp}-test_7_p3_features_benchmark.toon`);
writeFileSync(outPath, toon, "utf8");
console.log(`[test_7] wrote ${outPath}`);
process.exit(0);