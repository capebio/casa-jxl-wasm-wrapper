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

// brotliEffort controls entropy-coding compression level for the Brotli back-end.
// Higher effort = smaller file at the cost of longer encode time.
// -1 means "use encoder default" (auto). 0-11 are explicit levels.
// Sweep brotliEffort across two effort levels to quantify size savings vs encode cost.
const TARGET        = Number(process.env.TEST11_TARGET ?? "1600");
const QUALITY       = Number(process.env.TEST11_QUALITY ?? "85");
const LIMIT         = Math.max(1, Number(process.env.TEST11_LIMIT ?? "2"));
const JXL_EFFORTS   = parseList(process.env.TEST11_EFFORTS ?? "3,5");
const BROTLI_LEVELS = parseList(process.env.TEST11_BROTLI_LEVELS ?? "-1,0,4,9,11");

function parseList(s) { return s.split(",").map(Number).filter(Number.isFinite); }

await initRawWasm();
ensureTimingOutDir();

const tier  = detectTier();
const files = selectRawFiles({
  primaryDir: process.env.TEST11_RAW_DIR ?? GOBABEB_DIR,
  extensions: [".orf"],
  limit: LIMIT,
  largest: true,
});
if (!files.length) throw new Error("test_11 needs at least one ORF file");

const records = [];
for (const file of files) {
  const decoded = decodeRawToRgba(file.path, TARGET);
  for (const effort of JXL_EFFORTS) {
    for (const brotliEffort of BROTLI_LEVELS) {
      const encoderOpts = {
        quality: QUALITY,
        effort,
        progressive: true,
        progressiveFlavor: "ac",
        previewFirst: false,
        chunked: true,
      };
      if (brotliEffort >= 0) encoderOpts.brotliEffort = brotliEffort;

      const encoded = await encodeJxl(createEncoder, decoded.rgba, decoded.width, decoded.height, encoderOpts);
      const dec     = await decodeJxl(createDecoder, encoded.bytes, {
        emitEveryPass: false,
        progressiveDetail: "passes",
        downsample: 1,
      });
      records.push({
        timestamp: new Date().toISOString(),
        file: basename(file.path),
        effort,
        brotliEffort,
        encodeMs: encoded.ms,
        decodeMs: dec.ms,
        size: encoded.bytes.byteLength,
      });
      console.log(`[test_11] ${basename(file.path)} effort=${effort} brotliEffort=${brotliEffort} enc=${encoded.ms.toFixed(0)}ms dec=${dec.ms.toFixed(0)}ms size=${encoded.bytes.byteLength}B`);
    }
  }
}

const stamp = stampForFile();
const toon  = formatToon({
  testName:  "BrotliEffort vs Encode Time (Test_11)",
  timestamp: new Date().toISOString(),
  tier,
  target:    TARGET,
  quality:   QUALITY,
  notes:     "effort(3,5) x brotliEffort(-1=auto,0,4,9,11); encode time and file size",
  columns:   ["t", "file", "effort", "brotli", "encode_ms", "decode_ms", "size"],
  records,
  row: (r, timeBase) => [
    r.timestamp.startsWith(timeBase) ? r.timestamp.slice(timeBase.length).replace(/Z$/, "") : r.timestamp,
    r.file,
    r.effort,
    r.brotliEffort,
    fmtMs(r.encodeMs),
    fmtMs(r.decodeMs),
    `${r.size}B`,
  ],
});
const outPath = join(TIMING_OUT_DIR, `${stamp}-test_11_brotli_effort_sweep.toon`);
writeFileSync(outPath, toon, "utf8");
console.log(`[test_11] wrote ${outPath}`);
process.exit(0);
