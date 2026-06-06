import { writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";

import {
  GOBABEB_DIR,
  TEST_ROOT,
  TIMING_OUT_DIR,
  decodeJxl,
  decodeRawToRgba,
  encodeJxl,
  ensureTimingOutDir,
  fmtMs,
  formatToon,
  initRawWasm,
  installBrowserLikeWorker,
  listRawFiles,
  stampForFile,
} from "./optimal-settings-timing-utils.mjs";

installBrowserLikeWorker();
const { createDecoder, createEncoder, detectTier } = await import("../packages/jxl-wasm/dist/index.js");

const TARGET = Number(process.env.TEST21_TARGET ?? "1600");
const QUALITY = Number(process.env.TEST21_QUALITY ?? "85");
const EFFORT = Number(process.env.TEST21_EFFORT ?? "3");
const PER_TYPE = Math.max(1, Number(process.env.TEST21_PER_TYPE ?? "1"));

await initRawWasm();
ensureTimingOutDir();

const tier = detectTier();
const sourceDir = process.env.TEST21_RAW_DIR ?? TEST_ROOT;
let files = pickByType(listRawFiles({
  dir: sourceDir,
  extensions: [".orf", ".raw", ".dng", ".cr2"],
  limit: 200,
  largest: true,
}), PER_TYPE);
if (!files.length) {
  files = pickByType(listRawFiles({
    dir: GOBABEB_DIR,
    extensions: [".orf"],
    limit: PER_TYPE,
    largest: true,
  }), PER_TYPE);
}
if (!files.length) throw new Error("test_21 needs at least one RAW-family file");

const records = [];
for (const file of files) {
  const decoded = decodeRawToRgba(file.path, TARGET);
  const source_type = extname(file.path).slice(1).toLowerCase();
  const encoded = await encodeJxl(createEncoder, decoded.rgba, decoded.width, decoded.height, {
    quality: QUALITY,
    effort: EFFORT,
    progressive: true,
    progressiveFlavor: "ac",
    previewFirst: false,
    chunked: true,
  });
  const dec = await decodeJxl(createDecoder, encoded.bytes, {
    emitEveryPass: false,
    progressiveDetail: "passes",
  });
  records.push({
    timestamp: new Date().toISOString(),
    file: basename(file.path),
    source_type,
    rawMs: decoded.rawMs,
    rgbaMs: decoded.rgbaMs,
    encodeMs: encoded.ms,
    decodeMs: dec.ms,
    totalMs: decoded.rawMs + decoded.rgbaMs + encoded.ms + dec.ms,
    size: encoded.bytes.byteLength,
  });
  console.log(`[test_21] ${basename(file.path)} source_type=${source_type} raw=${decoded.rawMs.toFixed(0)}ms rgba=${decoded.rgbaMs.toFixed(0)}ms enc=${encoded.ms.toFixed(0)}ms dec=${dec.ms.toFixed(0)}ms size=${encoded.bytes.byteLength}B`);
}

const stamp = stampForFile();
const toon = formatToon({
  testName: "Source Format Sweep (Test_21)",
  timestamp: new Date().toISOString(),
  tier,
  target: TARGET,
  quality: QUALITY,
  effort: EFFORT,
  notes: "source_type sweep across available RAW-family fixtures; compares local pipeline costs by file format",
  columns: ["t", "file", "source_type", "raw_ms", "rgba_ms", "encode_ms", "decode_ms", "total_ms", "size"],
  records,
  row: (r, timeBase) => [
    r.timestamp.startsWith(timeBase) ? r.timestamp.slice(timeBase.length).replace(/Z$/, "") : r.timestamp,
    r.file,
    r.source_type,
    fmtMs(r.rawMs),
    fmtMs(r.rgbaMs),
    fmtMs(r.encodeMs),
    fmtMs(r.decodeMs),
    fmtMs(r.totalMs),
    `${r.size}B`,
  ],
});
const outPath = join(TIMING_OUT_DIR, `${stamp}-test_21_source_format_sweep.toon`);
writeFileSync(outPath, toon, "utf8");
console.log(`[test_21] wrote ${outPath}`);
process.exit(0);

function pickByType(files, perType) {
  const counts = new Map();
  const picked = [];
  for (const file of files) {
    const type = extname(file.path).toLowerCase();
    const count = counts.get(type) ?? 0;
    if (count >= perType) continue;
    counts.set(type, count + 1);
    picked.push(file);
  }
  return picked;
}
