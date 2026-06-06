import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import {
  GOBABEB_DIR,
  TIMING_OUT_DIR,
  decodeJxl,
  decodeRawToRgba,
  ensureTimingOutDir,
  fmtMs,
  formatToon,
  initRawWasm,
  installBrowserLikeWorker,
  selectRawFiles,
  stampForFile,
} from "./optimal-settings-timing-utils.mjs";
import { encodeJxlMatrix, loadJxlCoreModule } from "./correlation-matrix-benchmark-utils.mjs";

installBrowserLikeWorker();
const { createDecoder, detectTier } = await import("../packages/jxl-wasm/dist/index.js");

const TARGET = Number(process.env.TEST14_TARGET ?? "1600");
const QUALITY = Number(process.env.TEST14_QUALITY ?? "85");
const EFFORT = Number(process.env.TEST14_EFFORT ?? "3");
const LIMIT = Math.max(1, Number(process.env.TEST14_LIMIT ?? "3"));
const MODULAR = parseList(process.env.TEST14_MODULAR ?? "-1,0,1");

function parseList(value) { return String(value).split(",").map(Number).filter(Number.isFinite); }

await initRawWasm();
ensureTimingOutDir();

const tier = detectTier();
const jxlCore = await loadJxlCoreModule(tier);
const files = selectRawFiles({
  primaryDir: process.env.TEST14_RAW_DIR ?? GOBABEB_DIR,
  extensions: [".orf"],
  limit: LIMIT,
  largest: true,
});
if (!files.length) throw new Error("test_14 needs at least one ORF file");

const records = [];
for (const file of files) {
  const decoded = decodeRawToRgba(file.path, TARGET);
  for (const modular of MODULAR) {
    const opts = {
      quality: QUALITY,
      effort: EFFORT,
      progressive: true,
      progressiveFlavor: "ac",
      previewFirst: false,
      chunked: true,
    };
    if (modular >= 0) opts.modular = modular;
    const encoded = await encodeJxlMatrix(jxlCore, decoded.rgba, decoded.width, decoded.height, opts);
    const dec = await decodeJxl(createDecoder, encoded.bytes, {
      emitEveryPass: false,
      progressiveDetail: "passes",
    });
    records.push({
      timestamp: new Date().toISOString(),
      file: basename(file.path),
      modular,
      rawMs: decoded.rawMs,
      rgbaMs: decoded.rgbaMs,
      encodeMs: encoded.ms,
      decodeMs: dec.ms,
      totalMs: decoded.rawMs + decoded.rgbaMs + encoded.ms + dec.ms,
      size: encoded.bytes.byteLength,
    });
    console.log(`[test_14] ${basename(file.path)} modular=${modular} raw=${decoded.rawMs.toFixed(0)}ms rgba=${decoded.rgbaMs.toFixed(0)}ms enc=${encoded.ms.toFixed(0)}ms dec=${dec.ms.toFixed(0)}ms size=${encoded.bytes.byteLength}B`);
  }
}

const stamp = stampForFile();
const toon = formatToon({
  testName: "Modular Mode Sweep (Test_14)",
  timestamp: new Date().toISOString(),
  tier,
  target: TARGET,
  quality: QUALITY,
  effort: EFFORT,
  notes: "modular(-1 auto,0 VarDCT,1 Modular) at locked lightbox settings",
  columns: ["t", "file", "modular", "raw_ms", "rgba_ms", "encode_ms", "decode_ms", "total_ms", "size"],
  records,
  row: (r, timeBase) => [
    r.timestamp.startsWith(timeBase) ? r.timestamp.slice(timeBase.length).replace(/Z$/, "") : r.timestamp,
    r.file,
    r.modular,
    fmtMs(r.rawMs),
    fmtMs(r.rgbaMs),
    fmtMs(r.encodeMs),
    fmtMs(r.decodeMs),
    fmtMs(r.totalMs),
    `${r.size}B`,
  ],
});
const outPath = join(TIMING_OUT_DIR, `${stamp}-test_14_modular_mode_sweep.toon`);
writeFileSync(outPath, toon, "utf8");
console.log(`[test_14] wrote ${outPath}`);
process.exit(0);
