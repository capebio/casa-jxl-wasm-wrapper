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

// epf = edge-preserving filter strength (0=off, 1-3=increasing smoothing).
// gaborish = gabor-like unsharpening pre-pass (0=off, 1=on).
// Together they affect visual quality per byte without changing encode algorithm.
// Sweep epf x gaborish to find the size/quality sweet spot at effort=3 quality=85.
const TARGET  = Number(process.env.TEST10_TARGET ?? "1600");
const QUALITY = Number(process.env.TEST10_QUALITY ?? "85");
const EFFORT  = Number(process.env.TEST10_EFFORT ?? "3");
const LIMIT   = Math.max(1, Number(process.env.TEST10_LIMIT ?? "3"));
const EPF_LEVELS  = parseList(process.env.TEST10_EPF ?? "0,1,2,3");
const GABORISH    = parseList(process.env.TEST10_GABORISH ?? "0,1");

function parseList(s) { return s.split(",").map(Number).filter(Number.isFinite); }

await initRawWasm();
ensureTimingOutDir();

const tier  = detectTier();
const files = selectRawFiles({
  primaryDir: process.env.TEST10_RAW_DIR ?? GOBABEB_DIR,
  extensions: [".orf"],
  limit: LIMIT,
  largest: true,
});
if (!files.length) throw new Error("test_10 needs at least one ORF file");

const records = [];
for (const file of files) {
  const decoded = decodeRawToRgba(file.path, TARGET);
  for (const epf of EPF_LEVELS) {
    for (const gaborish of GABORISH) {
      const encoded = await encodeJxl(createEncoder, decoded.rgba, decoded.width, decoded.height, {
        quality: QUALITY,
        effort: EFFORT,
        progressive: true,
        progressiveFlavor: "ac",
        previewFirst: false,
        chunked: true,
        epf,
        gaborish,
      });
      const dec = await decodeJxl(createDecoder, encoded.bytes, {
        emitEveryPass: false,
        progressiveDetail: "passes",
        downsample: 1,
      });
      records.push({
        timestamp: new Date().toISOString(),
        file: basename(file.path),
        epf,
        gaborish,
        encodeMs: encoded.ms,
        decodeMs: dec.ms,
        size: encoded.bytes.byteLength,
      });
      console.log(`[test_10] ${basename(file.path)} epf=${epf} gaborish=${gaborish} enc=${encoded.ms.toFixed(0)}ms dec=${dec.ms.toFixed(0)}ms size=${encoded.bytes.byteLength}B`);
    }
  }
}

const stamp = stampForFile();
const toon  = formatToon({
  testName:  "EPF + Gaborish Quality Sweep (Test_10)",
  timestamp: new Date().toISOString(),
  tier,
  target:    TARGET,
  quality:   QUALITY,
  effort:    EFFORT,
  notes:     "epf(0-3) x gaborish(0,1); encode time, decode time, file size at effort=3 quality=85",
  columns:   ["t", "file", "epf", "gaborish", "encode_ms", "decode_ms", "size"],
  records,
  row: (r, timeBase) => [
    r.timestamp.startsWith(timeBase) ? r.timestamp.slice(timeBase.length).replace(/Z$/, "") : r.timestamp,
    r.file,
    r.epf,
    r.gaborish,
    fmtMs(r.encodeMs),
    fmtMs(r.decodeMs),
    `${r.size}B`,
  ],
});
const outPath = join(TIMING_OUT_DIR, `${stamp}-test_10_epf_gaborish_sweep.toon`);
writeFileSync(outPath, toon, "utf8");
console.log(`[test_10] wrote ${outPath}`);
process.exit(0);
