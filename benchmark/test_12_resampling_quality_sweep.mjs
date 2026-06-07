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
  fmtNum,
  formatToon,
  initRawWasm,
  installBrowserLikeWorker,
  selectRawFiles,
  stampForFile,
} from "./optimal-settings-timing-utils.mjs";

installBrowserLikeWorker();
const { createDecoder, createEncoder, detectTier } = await import("../packages/jxl-wasm/dist/index.js");

// resampling = encoder-side downsampling applied before encoding (-1=auto, 1=full, 2=half, 4=quarter).
// Higher resampling = smaller file + faster encode/decode at the cost of sharpness.
// Sweep resampling × quality to map the size-quality-speed surface.
const TARGET      = Number(process.env.TEST12_TARGET ?? "1600");
const EFFORT      = Number(process.env.TEST12_EFFORT ?? "3");
const LIMIT       = Math.max(1, Number(process.env.TEST12_LIMIT ?? "3"));
const QUALITIES   = parseList(process.env.TEST12_QUALITIES ?? "75,85,90");
const RESAMPLINGS = parseList(process.env.TEST12_RESAMPLINGS ?? "-1,1,2");

function parseList(s) { return s.split(",").map(Number).filter(Number.isFinite); }

await initRawWasm();
ensureTimingOutDir();

const tier  = detectTier();
const files = selectRawFiles({
  primaryDir: process.env.TEST12_RAW_DIR ?? GOBABEB_DIR,
  extensions: [".orf"],
  limit: LIMIT,
  largest: true,
});
if (!files.length) throw new Error("test_12 needs at least one ORF file");

const records = [];
for (const file of files) {
  const decoded = decodeRawToRgba(file.path, TARGET);
  for (const quality of QUALITIES) {
    for (const resampling of RESAMPLINGS) {
      const encoded = await encodeJxl(createEncoder, decoded.rgba, decoded.width, decoded.height, {
        quality,
        effort: EFFORT,
        progressive: true,
        progressiveFlavor: "ac",
        previewFirst: false,
        chunked: true,
        resampling,
      });
      const dec = await decodeJxl(createDecoder, encoded.bytes, {
        emitEveryPass: false,
        progressiveDetail: "passes",
        downsample: 1,
      });
      // bytes per pixel ratio relative to baseline (quality=75, resampling=-1)
      records.push({
        timestamp: new Date().toISOString(),
        file: basename(file.path),
        quality,
        resampling,
        encodeMs: encoded.ms,
        decodeMs: dec.ms,
        size: encoded.bytes.byteLength,
      });
      console.log(`[test_12] ${basename(file.path)} quality=${quality} resampling=${resampling} enc=${encoded.ms.toFixed(0)}ms dec=${dec.ms.toFixed(0)}ms size=${encoded.bytes.byteLength}B`);
    }
  }
}

const stamp = stampForFile();
const toon  = formatToon({
  testName:  "Resampling x Quality Sweep (Test_12)",
  timestamp: new Date().toISOString(),
  tier,
  target:    TARGET,
  effort:    EFFORT,
  notes:     "quality(75,85,90) x resampling(-1=auto,1=full,2=half); size-quality-speed surface at 1600px",
  columns:   ["t", "file", "quality", "resampling", "encode_ms", "decode_ms", "size"],
  records,
  row: (r, timeBase) => [
    r.timestamp.startsWith(timeBase) ? r.timestamp.slice(timeBase.length).replace(/Z$/, "") : r.timestamp,
    r.file,
    r.quality,
    r.resampling,
    fmtMs(r.encodeMs),
    fmtMs(r.decodeMs),
    `${r.size}B`,
  ],
});
const outPath = join(TIMING_OUT_DIR, `${stamp}-test_12_resampling_quality_sweep.toon`);
writeFileSync(outPath, toon, "utf8");
console.log(`[test_12] wrote ${outPath}`);
process.exit(0);
