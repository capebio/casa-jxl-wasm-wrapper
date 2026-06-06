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

const TARGET = Number(process.env.TEST22_TARGET ?? "1600");
const QUALITY = Number(process.env.TEST22_QUALITY ?? "85");
const EFFORT = Number(process.env.TEST22_EFFORT ?? "3");
const LIMIT = Math.max(1, Number(process.env.TEST22_LIMIT ?? "2"));
const CASES = [
  { label: "lossy_auto", lossless: 0, modular: -1, quality: QUALITY },
  { label: "lossy_vardct", lossless: 0, modular: 0, quality: QUALITY },
  { label: "lossless_modular", lossless: 1, modular: 1, quality: 100 },
];

await initRawWasm();
ensureTimingOutDir();

const tier = detectTier();
const jxlCore = await loadJxlCoreModule(tier);
const files = selectRawFiles({
  primaryDir: process.env.TEST22_RAW_DIR ?? GOBABEB_DIR,
  extensions: [".orf"],
  limit: LIMIT,
  largest: true,
});
if (!files.length) throw new Error("test_22 needs at least one ORF file");

const records = [];
for (const file of files) {
  const decoded = decodeRawToRgba(file.path, TARGET);
  for (const matrixCase of CASES) {
    const encoded = await encodeJxlMatrix(jxlCore, decoded.rgba, decoded.width, decoded.height, {
      quality: matrixCase.quality,
      distance: matrixCase.lossless ? 0 : undefined,
      effort: EFFORT,
      progressive: true,
      previewFirst: false,
      chunked: true,
      modular: matrixCase.modular,
    });
    const dec = await decodeJxl(createDecoder, encoded.bytes, {
      emitEveryPass: false,
      progressiveDetail: "passes",
    });
    records.push({
      timestamp: new Date().toISOString(),
      file: basename(file.path),
      mode: matrixCase.label,
      quality: matrixCase.quality,
      lossless: matrixCase.lossless,
      modular: matrixCase.modular,
      rawMs: decoded.rawMs,
      rgbaMs: decoded.rgbaMs,
      encodeMs: encoded.ms,
      decodeMs: dec.ms,
      totalMs: decoded.rawMs + decoded.rgbaMs + encoded.ms + dec.ms,
      size: encoded.bytes.byteLength,
    });
    console.log(`[test_22] ${basename(file.path)} mode=${matrixCase.label} lossless=${matrixCase.lossless} modular=${matrixCase.modular} raw=${decoded.rawMs.toFixed(0)}ms rgba=${decoded.rgbaMs.toFixed(0)}ms enc=${encoded.ms.toFixed(0)}ms dec=${dec.ms.toFixed(0)}ms size=${encoded.bytes.byteLength}B`);
  }
}

const stamp = stampForFile();
const toon = formatToon({
  testName: "Modular + Lossless Matrix (Test_22)",
  timestamp: new Date().toISOString(),
  tier,
  target: TARGET,
  effort: EFFORT,
  notes: "lossy auto/VarDCT vs lossless Modular; archival/local-computer cost against web settings",
  columns: ["t", "file", "mode", "quality", "lossless", "modular", "raw_ms", "rgba_ms", "encode_ms", "decode_ms", "total_ms", "size"],
  records,
  row: (r, timeBase) => [
    r.timestamp.startsWith(timeBase) ? r.timestamp.slice(timeBase.length).replace(/Z$/, "") : r.timestamp,
    r.file,
    r.mode,
    r.quality,
    r.lossless,
    r.modular,
    fmtMs(r.rawMs),
    fmtMs(r.rgbaMs),
    fmtMs(r.encodeMs),
    fmtMs(r.decodeMs),
    fmtMs(r.totalMs),
    `${r.size}B`,
  ],
});
const outPath = join(TIMING_OUT_DIR, `${stamp}-test_22_modular_lossless_matrix.toon`);
writeFileSync(outPath, toon, "utf8");
console.log(`[test_22] wrote ${outPath}`);
process.exit(0);
