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

const EFFORT = Number(process.env.TEST20_EFFORT ?? "3");
const LIMIT = Math.max(1, Number(process.env.TEST20_LIMIT ?? "1"));
const TARGETS = parseList(process.env.TEST20_TARGETS ?? "400,800,1600,2400");
const THUMB_QUALITY = Number(process.env.TEST20_THUMB_QUALITY ?? "80");
const QUALITY = Number(process.env.TEST20_QUALITY ?? "85");

function parseList(value) { return String(value).split(",").map(Number).filter(Number.isFinite); }

await initRawWasm();
ensureTimingOutDir();

const tier = detectTier();
const files = selectRawFiles({
  primaryDir: process.env.TEST20_RAW_DIR ?? GOBABEB_DIR,
  extensions: [".orf"],
  limit: LIMIT,
  largest: true,
});
if (!files.length) throw new Error("test_20 needs at least one ORF file");

const records = [];
for (const file of files) {
  for (const target of TARGETS) {
    const decoded = decodeRawToRgba(file.path, target);
    const quality = target <= 400 ? THUMB_QUALITY : QUALITY;
    const encoded = await encodeJxl(createEncoder, decoded.rgba, decoded.width, decoded.height, {
      quality,
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
      target,
      width: decoded.width,
      height: decoded.height,
      quality,
      rawMs: decoded.rawMs,
      rgbaMs: decoded.rgbaMs,
      encodeMs: encoded.ms,
      decodeMs: dec.ms,
      totalMs: decoded.rawMs + decoded.rgbaMs + encoded.ms + dec.ms,
      size: encoded.bytes.byteLength,
    });
    console.log(`[test_20] ${basename(file.path)} target=${target} quality=${quality} raw=${decoded.rawMs.toFixed(0)}ms rgba=${decoded.rgbaMs.toFixed(0)}ms enc=${encoded.ms.toFixed(0)}ms dec=${dec.ms.toFixed(0)}ms size=${encoded.bytes.byteLength}B`);
  }
}

const stamp = stampForFile();
const toon = formatToon({
  testName: "Target Size Ladder Sweep (Test_20)",
  timestamp: new Date().toISOString(),
  tier,
  target: "400,800,1600,2400",
  effort: EFFORT,
  notes: "target ladder; q80 for 400px thumbnails, q85 for larger local/lightbox sizes",
  columns: ["t", "file", "target", "w", "h", "quality", "raw_ms", "rgba_ms", "encode_ms", "decode_ms", "total_ms", "size"],
  records,
  row: (r, timeBase) => [
    r.timestamp.startsWith(timeBase) ? r.timestamp.slice(timeBase.length).replace(/Z$/, "") : r.timestamp,
    r.file,
    r.target,
    r.width,
    r.height,
    r.quality,
    fmtMs(r.rawMs),
    fmtMs(r.rgbaMs),
    fmtMs(r.encodeMs),
    fmtMs(r.decodeMs),
    fmtMs(r.totalMs),
    `${r.size}B`,
  ],
});
const outPath = join(TIMING_OUT_DIR, `${stamp}-test_20_target_size_ladder_sweep.toon`);
writeFileSync(outPath, toon, "utf8");
console.log(`[test_20] wrote ${outPath}`);
process.exit(0);
