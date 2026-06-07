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

const TARGET = Number(process.env.TEST19_TARGET ?? "1600");
const QUALITY = Number(process.env.TEST19_QUALITY ?? "85");
const LIMIT = Math.max(1, Number(process.env.TEST19_LIMIT ?? "2"));
const EFFORTS = parseList(process.env.TEST19_EFFORTS ?? "1,2,3,4");

function parseList(value) { return String(value).split(",").map(Number).filter(Number.isFinite); }

await initRawWasm();
ensureTimingOutDir();

const tier = detectTier();
const files = selectRawFiles({
  primaryDir: process.env.TEST19_RAW_DIR ?? GOBABEB_DIR,
  extensions: [".orf"],
  limit: LIMIT,
  largest: true,
});
if (!files.length) throw new Error("test_19 needs at least one ORF file");

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
    const dec = await decodeJxl(createDecoder, encoded.bytes, {
      emitEveryPass: false,
      progressiveDetail: "passes",
    });
    records.push({
      timestamp: new Date().toISOString(),
      file: basename(file.path),
      effort,
      rawMs: decoded.rawMs,
      rgbaMs: decoded.rgbaMs,
      encodeMs: encoded.ms,
      decodeMs: dec.ms,
      totalMs: decoded.rawMs + decoded.rgbaMs + encoded.ms + dec.ms,
      size: encoded.bytes.byteLength,
    });
    console.log(`[test_19] ${basename(file.path)} effort=${effort} raw=${decoded.rawMs.toFixed(0)}ms rgba=${decoded.rgbaMs.toFixed(0)}ms enc=${encoded.ms.toFixed(0)}ms dec=${dec.ms.toFixed(0)}ms size=${encoded.bytes.byteLength}B`);
  }
}

const stamp = stampForFile();
const toon = formatToon({
  testName: "Effort Shipping Window Sweep (Test_19)",
  timestamp: new Date().toISOString(),
  tier,
  target: TARGET,
  quality: QUALITY,
  notes: "effort(1,2,3,4); narrow shipping window around current effort=3 default",
  columns: ["t", "file", "effort", "raw_ms", "rgba_ms", "encode_ms", "decode_ms", "total_ms", "size"],
  records,
  row: (r, timeBase) => [
    r.timestamp.startsWith(timeBase) ? r.timestamp.slice(timeBase.length).replace(/Z$/, "") : r.timestamp,
    r.file,
    r.effort,
    fmtMs(r.rawMs),
    fmtMs(r.rgbaMs),
    fmtMs(r.encodeMs),
    fmtMs(r.decodeMs),
    fmtMs(r.totalMs),
    `${r.size}B`,
  ],
});
const outPath = join(TIMING_OUT_DIR, `${stamp}-test_19_effort_shipping_window_sweep.toon`);
writeFileSync(outPath, toon, "utf8");
console.log(`[test_19] wrote ${outPath}`);
process.exit(0);
