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

// decodingSpeed trades encode work for faster decode time (0=best ratio, 4=fastest decode).
// Sweep effort × decodingSpeed to find the cheapest setting that keeps decode fast.
const TARGET   = Number(process.env.TEST8_TARGET ?? "1600");
const QUALITY  = Number(process.env.TEST8_QUALITY ?? "85");
const LIMIT    = Math.max(1, Number(process.env.TEST8_LIMIT ?? "2"));
const EFFORTS  = parseList(process.env.TEST8_EFFORTS ?? "3,5");
const DEC_SPEEDS = parseList(process.env.TEST8_DEC_SPEEDS ?? "0,1,2,3");

function parseList(s) { return s.split(",").map(Number).filter(Number.isFinite); }

await initRawWasm();
ensureTimingOutDir();

const tier  = detectTier();
const files = selectRawFiles({
  primaryDir: process.env.TEST8_RAW_DIR ?? GOBABEB_DIR,
  extensions: [".orf"],
  limit: LIMIT,
  largest: true,
});
if (!files.length) throw new Error("test_8 needs at least one ORF file");

const records = [];
for (const file of files) {
  const decoded = decodeRawToRgba(file.path, TARGET);
  for (const effort of EFFORTS) {
    for (const decodingSpeed of DEC_SPEEDS) {
      const encoded = await encodeJxl(createEncoder, decoded.rgba, decoded.width, decoded.height, {
        quality: QUALITY,
        effort,
        progressive: true,
        progressiveFlavor: "ac",
        previewFirst: false,
        chunked: true,
        decodingSpeed,
      });
      const dec = await decodeJxl(createDecoder, encoded.bytes, {
        emitEveryPass: false,
        progressiveDetail: "passes",
        downsample: 1,
      });
      records.push({
        timestamp: new Date().toISOString(),
        file: basename(file.path),
        effort,
        decodingSpeed,
        encodeMs: encoded.ms,
        decodeMs: dec.ms,
        size: encoded.bytes.byteLength,
      });
      console.log(`[test_8] ${basename(file.path)} effort=${effort} decodingSpeed=${decodingSpeed} enc=${encoded.ms.toFixed(0)}ms dec=${dec.ms.toFixed(0)}ms size=${encoded.bytes.byteLength}B`);
    }
  }
}

const stamp = stampForFile();
const toon  = formatToon({
  testName:  "DecodingSpeed Sweep (Test_8)",
  timestamp: new Date().toISOString(),
  tier,
  target:    TARGET,
  quality:   QUALITY,
  notes:     "effort x decodingSpeed (0-3); measures encode vs decode time tradeoff",
  columns:   ["t", "file", "effort", "dec_speed", "encode_ms", "decode_ms", "size"],
  records,
  row: (r, timeBase) => [
    r.timestamp.startsWith(timeBase) ? r.timestamp.slice(timeBase.length).replace(/Z$/, "") : r.timestamp,
    r.file,
    r.effort,
    r.decodingSpeed,
    fmtMs(r.encodeMs),
    fmtMs(r.decodeMs),
    `${r.size}B`,
  ],
});
const outPath = join(TIMING_OUT_DIR, `${stamp}-test_8_decoding_speed_sweep.toon`);
writeFileSync(outPath, toon, "utf8");
console.log(`[test_8] wrote ${outPath}`);
process.exit(0);
