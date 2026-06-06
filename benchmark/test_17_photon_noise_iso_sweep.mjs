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

const TARGET = Number(process.env.TEST17_TARGET ?? "1600");
const QUALITY = Number(process.env.TEST17_QUALITY ?? "85");
const EFFORT = Number(process.env.TEST17_EFFORT ?? "3");
const LIMIT = Math.max(1, Number(process.env.TEST17_LIMIT ?? "3"));
const PHOTON_NOISE_ISO = parseList(process.env.TEST17_PHOTON_NOISE_ISO ?? "0,200,800,1600");

function parseList(value) { return String(value).split(",").map(Number).filter(Number.isFinite); }

await initRawWasm();
ensureTimingOutDir();

const tier = detectTier();
const jxlCore = await loadJxlCoreModule(tier);
const files = selectRawFiles({
  primaryDir: process.env.TEST17_RAW_DIR ?? GOBABEB_DIR,
  extensions: [".orf"],
  limit: LIMIT,
  largest: true,
});
if (!files.length) throw new Error("test_17 needs at least one ORF file");

const records = [];
for (const file of files) {
  const decoded = decodeRawToRgba(file.path, TARGET);
  for (const photonNoiseIso of PHOTON_NOISE_ISO) {
    const opts = {
      quality: QUALITY,
      effort: EFFORT,
      progressive: true,
      progressiveFlavor: "ac",
      previewFirst: false,
      chunked: true,
    };
    if (photonNoiseIso > 0) opts.photonNoiseIso = photonNoiseIso;
    const encoded = await encodeJxlMatrix(jxlCore, decoded.rgba, decoded.width, decoded.height, opts);
    const dec = await decodeJxl(createDecoder, encoded.bytes, {
      emitEveryPass: false,
      progressiveDetail: "passes",
    });
    records.push({
      timestamp: new Date().toISOString(),
      file: basename(file.path),
      photonNoiseIso,
      rawMs: decoded.rawMs,
      rgbaMs: decoded.rgbaMs,
      encodeMs: encoded.ms,
      decodeMs: dec.ms,
      totalMs: decoded.rawMs + decoded.rgbaMs + encoded.ms + dec.ms,
      size: encoded.bytes.byteLength,
    });
    console.log(`[test_17] ${basename(file.path)} photonNoiseIso=${photonNoiseIso} raw=${decoded.rawMs.toFixed(0)}ms rgba=${decoded.rgbaMs.toFixed(0)}ms enc=${encoded.ms.toFixed(0)}ms dec=${dec.ms.toFixed(0)}ms size=${encoded.bytes.byteLength}B`);
  }
}

const stamp = stampForFile();
const toon = formatToon({
  testName: "PhotonNoiseIso Sweep (Test_17)",
  timestamp: new Date().toISOString(),
  tier,
  target: TARGET,
  quality: QUALITY,
  effort: EFFORT,
  notes: "photonNoiseIso(0,200,800,1600); synthetic noise impact on size and timing",
  columns: ["t", "file", "photon_noise_iso", "raw_ms", "rgba_ms", "encode_ms", "decode_ms", "total_ms", "size"],
  records,
  row: (r, timeBase) => [
    r.timestamp.startsWith(timeBase) ? r.timestamp.slice(timeBase.length).replace(/Z$/, "") : r.timestamp,
    r.file,
    r.photonNoiseIso,
    fmtMs(r.rawMs),
    fmtMs(r.rgbaMs),
    fmtMs(r.encodeMs),
    fmtMs(r.decodeMs),
    fmtMs(r.totalMs),
    `${r.size}B`,
  ],
});
const outPath = join(TIMING_OUT_DIR, `${stamp}-test_17_photon_noise_iso_sweep.toon`);
writeFileSync(outPath, toon, "utf8");
console.log(`[test_17] wrote ${outPath}`);
process.exit(0);
