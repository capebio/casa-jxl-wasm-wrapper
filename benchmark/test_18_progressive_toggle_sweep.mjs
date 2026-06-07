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
} from "./optimal-settings-timing-utils.mjs";

installBrowserLikeWorker();
const { createDecoder, createEncoder, detectTier } = await import("../packages/jxl-wasm/dist/index.js");

const TARGET = Number(process.env.TEST18_TARGET ?? "1600");
const QUALITY = Number(process.env.TEST18_QUALITY ?? "85");
const EFFORT = Number(process.env.TEST18_EFFORT ?? "3");
const LIMIT = Math.max(1, Number(process.env.TEST18_LIMIT ?? "2"));
const PROGRESSIVE = parseList(process.env.TEST18_PROGRESSIVE ?? "0,1");

function parseList(value) { return String(value).split(",").map(Number).filter(Number.isFinite); }

await initRawWasm();
ensureTimingOutDir();

const tier = detectTier();
const files = selectRawFiles({
  primaryDir: process.env.TEST18_RAW_DIR ?? GOBABEB_DIR,
  extensions: [".orf"],
  limit: LIMIT,
  largest: true,
});
if (!files.length) throw new Error("test_18 needs at least one ORF file");

const records = [];
for (const file of files) {
  const decoded = decodeRawToRgba(file.path, TARGET);
  for (const progressive of PROGRESSIVE) {
    const encoded = await encodeJxl(createEncoder, decoded.rgba, decoded.width, decoded.height, {
      quality: QUALITY,
      effort: EFFORT,
      progressive: Boolean(progressive),
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
      progressive,
      rawMs: decoded.rawMs,
      rgbaMs: decoded.rgbaMs,
      encodeMs: encoded.ms,
      decodeMs: dec.ms,
      totalMs: decoded.rawMs + decoded.rgbaMs + encoded.ms + dec.ms,
      size: encoded.bytes.byteLength,
    });
    console.log(`[test_18] ${basename(file.path)} progressive=${progressive} raw=${decoded.rawMs.toFixed(0)}ms rgba=${decoded.rgbaMs.toFixed(0)}ms enc=${encoded.ms.toFixed(0)}ms dec=${dec.ms.toFixed(0)}ms size=${encoded.bytes.byteLength}B`);
  }
}

const stamp = stampForFile();
const toon = formatToon({
  testName: "Progressive Toggle Sweep (Test_18)",
  timestamp: new Date().toISOString(),
  tier,
  target: TARGET,
  quality: QUALITY,
  effort: EFFORT,
  notes: "progressive(0,1); local/on-computer final decode proxy vs streaming-ready asset cost",
  columns: ["t", "file", "progressive", "raw_ms", "rgba_ms", "encode_ms", "decode_ms", "total_ms", "size"],
  records,
  row: (r, timeBase) => [
    r.timestamp.startsWith(timeBase) ? r.timestamp.slice(timeBase.length).replace(/Z$/, "") : r.timestamp,
    r.file,
    r.progressive,
    fmtMs(r.rawMs),
    fmtMs(r.rgbaMs),
    fmtMs(r.encodeMs),
    fmtMs(r.decodeMs),
    fmtMs(r.totalMs),
    `${r.size}B`,
  ],
});
const outPath = join(TIMING_OUT_DIR, `${stamp}-test_18_progressive_toggle_sweep.toon`);
writeFileSync(outPath, toon, "utf8");
console.log(`[test_18] wrote ${outPath}`);
process.exit(0);
