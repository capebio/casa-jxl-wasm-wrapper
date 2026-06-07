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
  terminateBrowserLikeWorkers,
} from "./optimal-settings-timing-utils.mjs";

installBrowserLikeWorker();
const { createDecoder, createEncoder, detectTier } = await import("../packages/jxl-wasm/dist/index.js");

const TARGET = Number(process.env.TEST5_TARGET ?? process.env.SSIM_TARGET ?? "1600");
const QUALITY = Number(process.env.TEST5_QUALITY ?? process.env.SSIM_QUALITY ?? "85");
const EFFORT = Number(process.env.TEST5_EFFORT ?? process.env.SSIM_EFFORT ?? "3");
const LIMIT = Math.max(1, Number(process.env.TEST5_LIMIT ?? process.env.SSIM_LIMIT ?? "1"));
const CUTOFFS = String(process.env.TEST5_CUTOFFS ?? "25,50,75,100").split(",").map(Number).filter(Number.isFinite);

await initRawWasm();
ensureTimingOutDir();

const tier = detectTier();
const files = selectRawFiles({
  primaryDir: process.env.TEST5_RAW_DIR ?? GOBABEB_DIR,
  extensions: [".orf"],
  limit: LIMIT,
  largest: true,
});
if (!files.length) throw new Error("test_5 needs at least one ORF file");

const records = [];
for (const file of files) {
  const decoded = decodeRawToRgba(file.path, TARGET);
  const encoded = await encodeJxl(createEncoder, decoded.rgba, decoded.width, decoded.height, {
    quality: QUALITY,
    effort: EFFORT,
    progressive: true,
    progressiveFlavor: "ac",
    previewFirst: false,
    chunked: true,
  });
  const reference = await decodeJxl(createDecoder, encoded.bytes, {
    emitEveryPass: false,
    progressiveDetail: "passes",
  });
  const region = {
    x: Math.floor(decoded.width * 0.25),
    y: Math.floor(decoded.height * 0.25),
    w: Math.floor(decoded.width * 0.5),
    h: Math.floor(decoded.height * 0.5),
  };

  for (const cutoffPct of CUTOFFS) {
    const cutoffBytes = Math.min(encoded.bytes.byteLength, Math.max(1, Math.round(encoded.bytes.byteLength * cutoffPct / 100)));
    const slice = encoded.bytes.subarray(0, cutoffBytes);
    const full = await decodeJxl(createDecoder, slice, { emitEveryPass: true, progressiveDetail: "passes" });
    const ds2 = await decodeJxl(createDecoder, slice, { emitEveryPass: true, progressiveDetail: "passes", downsample: 2 });
    const roi = await decodeJxl(createDecoder, slice, { emitEveryPass: true, progressiveDetail: "passes", region });
    records.push({
      timestamp: new Date().toISOString(),
      file: basename(file.path),
      cutoffPct,
      cutoffBytes,
      rawMs: decoded.rawMs,
      rgbaMs: decoded.rgbaMs,
      encodeMs: encoded.ms,
      refMs: reference.ms,
      fullMs: full.ms,
      ds2Ms: ds2.ms,
      roiMs: roi.ms,
      firstMs: full.firstMs,
      passes: full.passes,
      psnr: computePsnr(full.pixels, reference.pixels),
      size: encoded.bytes.byteLength,
    });
    console.log(`[test_5] ${basename(file.path)} ${cutoffPct}% full=${full.ms.toFixed(0)}ms ds2=${ds2.ms.toFixed(0)}ms roi=${roi.ms.toFixed(0)}ms`);
  }
}

const stamp = stampForFile();
const toon = formatToon({
  testName: "First-Paint Optimization - Streaming (Test_5)",
  timestamp: new Date().toISOString(),
  tier,
  target: TARGET,
  quality: QUALITY,
  effort: EFFORT,
  notes: "Decode progressive JXL at cumulative byte cutoffs; compare full, downsample=2, and center ROI.",
  columns: ["t", "file", "cutoff", "bytes", "raw_ms", "rgba_ms", "encode_ms", "ref_ms", "first_ms", "full_ms", "ds2_ms", "roi_ms", "passes", "psnr", "size"],
  records,
  row: (record, timeBase) => [
    record.timestamp.startsWith(timeBase) ? record.timestamp.slice(timeBase.length).replace(/Z$/, "") : record.timestamp,
    record.file,
    `${record.cutoffPct}%`,
    record.cutoffBytes,
    fmtMs(record.rawMs),
    fmtMs(record.rgbaMs),
    fmtMs(record.encodeMs),
    fmtMs(record.refMs),
    fmtMs(record.firstMs),
    fmtMs(record.fullMs),
    fmtMs(record.ds2Ms),
    fmtMs(record.roiMs),
    record.passes,
    fmtNum(record.psnr, 2),
    `${record.size}B`,
  ],
});
const outPath = join(TIMING_OUT_DIR, `${stamp}-test_5_first_paint_streaming.toon`);
writeFileSync(outPath, toon, "utf8");
console.log(`[test_5] wrote ${outPath}`);
await terminateBrowserLikeWorkers();

function computePsnr(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let mse = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    const dr = a[i] - b[i];
    const dg = a[i + 1] - b[i + 1];
    const db = a[i + 2] - b[i + 2];
    mse += (dr * dr + dg * dg + db * db) / 3;
    n++;
  }
  mse /= Math.max(1, n);
  return mse === 0 ? 99.99 : 10 * Math.log10(65025 / mse);
}
