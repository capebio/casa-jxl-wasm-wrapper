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

const TARGET = Number(process.env.TEST15_TARGET ?? "1600");
const EFFORT = Number(process.env.TEST15_EFFORT ?? "3");
const LIMIT = Math.max(1, Number(process.env.TEST15_LIMIT ?? "2"));
const QUALITIES = parseList(process.env.TEST15_QUALITIES ?? "85,95");
const LOSSLESS = parseList(process.env.TEST15_LOSSLESS ?? "0,1");

function parseList(value) { return String(value).split(",").map(Number).filter(Number.isFinite); }

await initRawWasm();
ensureTimingOutDir();

const tier = detectTier();
const files = selectRawFiles({
  primaryDir: process.env.TEST15_RAW_DIR ?? GOBABEB_DIR,
  extensions: [".orf"],
  limit: LIMIT,
  largest: true,
});
if (!files.length) throw new Error("test_15 needs at least one ORF file");

const records = [];
for (const file of files) {
  const decoded = decodeRawToRgba(file.path, TARGET);
  for (const quality of QUALITIES) {
    for (const lossless of LOSSLESS) {
      const isLossless = lossless === 1;
      const encoded = await encodeJxl(createEncoder, decoded.rgba, decoded.width, decoded.height, {
        quality: isLossless ? 100 : quality,
        distance: isLossless ? 0 : null,
        effort: EFFORT,
        progressive: true,
        progressiveFlavor: "ac",
        previewFirst: false,
        chunked: true,
        modular: isLossless ? 1 : undefined,
      });
      const dec = await decodeJxl(createDecoder, encoded.bytes, {
        emitEveryPass: false,
        progressiveDetail: "passes",
      });
      records.push({
        timestamp: new Date().toISOString(),
        file: basename(file.path),
        quality,
        lossless,
        rawMs: decoded.rawMs,
        rgbaMs: decoded.rgbaMs,
        encodeMs: encoded.ms,
        decodeMs: dec.ms,
        totalMs: decoded.rawMs + decoded.rgbaMs + encoded.ms + dec.ms,
        size: encoded.bytes.byteLength,
      });
      console.log(`[test_15] ${basename(file.path)} quality=${quality} lossless=${lossless} raw=${decoded.rawMs.toFixed(0)}ms rgba=${decoded.rgbaMs.toFixed(0)}ms enc=${encoded.ms.toFixed(0)}ms dec=${dec.ms.toFixed(0)}ms size=${encoded.bytes.byteLength}B`);
    }
  }
}

const stamp = stampForFile();
const toon = formatToon({
  testName: "Lossless Ladder Sweep (Test_15)",
  timestamp: new Date().toISOString(),
  tier,
  target: TARGET,
  effort: EFFORT,
  notes: "lossless(0,1) x quality(85,95); compares archival path cost against high-quality lossy",
  columns: ["t", "file", "quality", "lossless", "raw_ms", "rgba_ms", "encode_ms", "decode_ms", "total_ms", "size"],
  records,
  row: (r, timeBase) => [
    r.timestamp.startsWith(timeBase) ? r.timestamp.slice(timeBase.length).replace(/Z$/, "") : r.timestamp,
    r.file,
    r.quality,
    r.lossless,
    fmtMs(r.rawMs),
    fmtMs(r.rgbaMs),
    fmtMs(r.encodeMs),
    fmtMs(r.decodeMs),
    fmtMs(r.totalMs),
    `${r.size}B`,
  ],
});
const outPath = join(TIMING_OUT_DIR, `${stamp}-test_15_lossless_ladder_sweep.toon`);
writeFileSync(outPath, toon, "utf8");
console.log(`[test_15] wrote ${outPath}`);
process.exit(0);
