import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { Worker as NodeWorker } from "node:worker_threads";
import sharp from "sharp";
import { collectHardwareTelemetry, formatTelemetryReport } from "./benchmark/hardware-telemetry.mjs";

// Browser-like Worker shim (identical to StandardMultifileTest)
class BrowserLikeWorker {
  #worker; #onmessage = null; #onerror = null;
  constructor(url, options = {}) {
    const workerUrl = url instanceof URL ? url.href : String(url);
    this.#worker = new NodeWorker(new URL("./jxl-worker-shim.mjs", import.meta.url), {
      workerData: { url: workerUrl, name: options.name ?? "" },
    });
    this.#worker.on("message", (data) => this.#onmessage?.({ data }));
    this.#worker.on("error", (error) => this.#onerror?.(error));
  }
  postMessage(msg, transfer) { this.#worker.postMessage(msg, transfer); }
  terminate() { return this.#worker.terminate(); }
  set onmessage(h) { this.#onmessage = h; }
  get onmessage() { return this.#onmessage; }
  set onerror(h) { this.#onerror = h; }
  get onerror() { return this.#onerror; }
}
globalThis.Worker = BrowserLikeWorker;

import initRaw, {
  downscale_rgb,
  process_orf_with_flags,
  process_cr2_with_flags,
  process_dng_with_flags,
  rgb_to_rgba,
} from "./pkg/raw_converter_wasm.js";

const { createDecoder, createEncoder, setForcedTier } =
  await import("./packages/jxl-wasm/dist/index.js");

await initRaw({ module_or_path: readFileSync(new URL("./pkg/raw_converter_wasm_bg.wasm", import.meta.url)) });

// Same fileset as StandardMultifileTest
const TEST_ROOT = String.raw`C:\Foo\raw-converter\tests`;
const GOB_ROOT  = String.raw`C:\995\2026-02-20 Gobabeb To Windhoek`;
const TIMING_SOURCE = String.raw`.timing-source`;
const FILES_CONFIG = [
  { name: "small_file.jpg",            paths: [join(TEST_ROOT, "small_file.jpg")] },
  { name: "P1110226 windows.jpg",      paths: [join(TEST_ROOT, "P1110226 windows.jpg")] },
  { name: "PXL_20260527_180319603.RAW-02.ORIGINAL.dng", paths: [
      join(TEST_ROOT, "PXL_20260527_180319603.RAW-02.ORIGINAL.dng"),
      join(TIMING_SOURCE, "PXL_20260527_180319603.RAW-02.ORIGINAL.dng"),
      String.raw`C:\Foo\raw-converter-wasm\.timing-source\PXL_20260527_180319603.RAW-02.ORIGINAL.dng`,
  ]},
  { name: "PXL_20260501_093507165.RAW-02.ORIGINAL.dng", paths: [
      join(TEST_ROOT, "PXL_20260501_093507165.RAW-02.ORIGINAL.dng"),
      String.raw`C:\Foo\raw-converter-wasm\.timing-source\PXL_20260501_093507165.RAW-02.ORIGINAL.dng`,
  ]},
  { name: "P1110226.ORF",  paths: [join(TEST_ROOT, "P1110226.ORF")] },
  { name: "P2200474.ORF",  paths: [join(GOB_ROOT, "P2200474.ORF")] },
  { name: "_MG_1750.CR2",  paths: [join(TEST_ROOT, "_MG_1750.CR2")] },
  { name: "ADH 1248.CR2",  paths: [join(TEST_ROOT, "ADH 1248.CR2")] },
];

const TARGET = 1920;
const OUTPUT_FULL_RGB = 1 | 2 | 4;
const PROCESS_ARGS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Number.NaN, Number.NaN, 0, 0];
const N_ROUNDS = 5;

function exactBuffer(view) {
  if (view instanceof ArrayBuffer) return view;
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view.buffer;
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}
function concatChunks(chunks) {
  const total = chunks.reduce((s, c) => s + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}
function median(arr) {
  if (!arr || !arr.length) return 0;
  const a = arr.slice().sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}

async function encodeJxl(rgba, width, height, progressive) {
  const encoder = createEncoder({
    format: "rgba8", width, height, hasAlpha: true,
    iccProfile: null, exif: null, xmp: null,
    distance: 1.0, quality: 85, effort: 3,
    progressive, progressiveFlavor: "ac", previewFirst: false,
    chunked: true,
  });
  const chunks = [];
  const chunkTask = (async () => {
    for await (const chunk of encoder.chunks())
      chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
  })();
  const t0 = performance.now();
  await encoder.pushPixels(exactBuffer(rgba));
  await encoder.finish();
  await chunkTask;
  await encoder.dispose();
  return { bytes: concatChunks(chunks), ms: performance.now() - t0 };
}

async function decodeJxl(jxlBytes, progressive) {
  const decoder = createDecoder({
    format: "rgba8",
    progressionTarget: "final",
    emitEveryPass: progressive,
    progressiveDetail: progressive ? "passes" : "none",
    downsample: 1,
    preserveIcc: false, preserveMetadata: false,
    region: null,
  });
  let firstFrameMs = null;
  const t0 = performance.now();
  try {
    const evTask = (async () => {
      for await (const ev of decoder.events()) {
        if (ev.type === "progress" || ev.type === "final") {
          if (firstFrameMs === null) firstFrameMs = performance.now() - t0;
        } else if (ev.type === "error") throw new Error(`${ev.code}: ${ev.message}`);
      }
    })();
    await decoder.push(exactBuffer(jxlBytes));
    await decoder.close();
    await evTask;
  } finally {
    try { await decoder.dispose(); } catch (_) {}
  }
  const ms = performance.now() - t0;
  return { ms, firstFrameMs: firstFrameMs ?? ms };
}

async function main() {
  const runTimestamp = new Date().toISOString();
  const batchName = process.argv[2] || process.env.SPEEDTEST_BATCH || "general";

  console.log(`\n=========================================`);
  console.log(`⚡ StandardEncDecTest — enc+dec only, ${N_ROUNDS} rounds`);
  console.log(`   Batch: ${batchName}  Timestamp: ${runTimestamp}`);
  console.log(`=========================================\n`);

  // Telemetry first (cold-state snapshot before any WASM work)
  console.log("--- System Telemetry ---");
  const telemetry = await collectHardwareTelemetry();
  console.log(formatTelemetryReport(telemetry));

  // Load + scale (identical to StandardMultifileTest [1/6])
  console.log("--- Loading & Scaling Assets ---");
  const loadedFiles = [];
  for (const config of FILES_CONFIG) {
    let resolvedPath = null;
    for (const p of config.paths) { if (existsSync(p)) { resolvedPath = p; break; } }
    if (!resolvedPath) { console.warn(`  ⚠ skip missing: ${config.name}`); continue; }

    const ext = extname(resolvedPath).toLowerCase();
    const raw = new Uint8Array(readFileSync(resolvedPath));
    const t0 = performance.now();
    let rgb, srcW, srcH;

    if (ext === ".jpg" || ext === ".jpeg") {
      const { data, info } = await sharp(resolvedPath).raw().toBuffer({ resolveWithObject: true });
      rgb = data; srcW = info.width; srcH = info.height;
    } else {
      const usePreview = ext === ".orf" || ext === ".raw";
      const fl = usePreview ? OUTPUT_FULL_RGB : 1;
      let decoded;
      if (ext === ".orf" || ext === ".raw") decoded = process_orf_with_flags(raw, fl, ...PROCESS_ARGS);
      else if (ext === ".cr2")              decoded = process_cr2_with_flags(raw, fl, ...PROCESS_ARGS);
      else if (ext === ".dng")              decoded = process_dng_with_flags(raw, fl, ...PROCESS_ARGS);
      rgb = decoded.take_rgb(); srcW = decoded.width; srcH = decoded.height; decoded.free();
    }
    const rawMs = performance.now() - t0;

    const longEdge = Math.max(srcW, srcH);
    const scale = longEdge > TARGET ? TARGET / longEdge : 1;
    const tgtW = Math.round(srcW * scale);
    const tgtH = Math.round(srcH * scale);
    const rgba = scale < 1 ? rgb_to_rgba(downscale_rgb(rgb, srcW, srcH, tgtW, tgtH)) : rgb_to_rgba(rgb);

    console.log(`  ${basename(resolvedPath)}: decode=${Math.round(rawMs)}ms  ${tgtW}x${tgtH}`);
    loadedFiles.push({ file: basename(resolvedPath), rgba, tgtW, tgtH });
  }
  console.log("");

  // Encode+decode flip-flop: N_ROUNDS rounds, interleaved simd/mt per round
  // Enc/dec is the very first WASM work — no prior warmup.
  console.log(`--- Enc+Dec Flip-Flop (${N_ROUNDS} rounds, simd ↔ relaxed-simd-mt) ---`);
  const samples = {};
  for (const f of loadedFiles) {
    samples[f.file] = {
      simd: { shot_enc: [], shot_dec: [], prog_enc: [], prog_first: [], prog_final: [] },
      mt:   { shot_enc: [], shot_dec: [], prog_enc: [], prog_first: [], prog_final: [] },
    };
  }

  for (let r = 0; r < N_ROUNDS; r++) {
    for (const tier of ["simd", "relaxed-simd-mt"]) {
      setForcedTier(tier);
      const key = tier === "simd" ? "simd" : "mt";
      for (const f of loadedFiles) {
        const s = samples[f.file][key];
        // one-shot
        const shotEnc = await encodeJxl(f.rgba, f.tgtW, f.tgtH, false);
        const shotDec = await decodeJxl(shotEnc.bytes, false).catch(() => ({ ms: 0, firstFrameMs: 0 }));
        s.shot_enc.push(shotEnc.ms);
        s.shot_dec.push(shotDec.ms);
        // progressive
        const progEnc = await encodeJxl(f.rgba, f.tgtW, f.tgtH, true);
        const progDec = await decodeJxl(progEnc.bytes, true).catch(() => ({ ms: 0, firstFrameMs: 0 }));
        s.prog_enc.push(progEnc.ms);
        s.prog_first.push(progDec.firstFrameMs);
        s.prog_final.push(progDec.ms);
      }
    }
    process.stdout.write(`  round ${r + 1}/${N_ROUNDS} done\n`);
  }

  // Compute medians
  const results = loadedFiles.map(f => {
    const s = samples[f.file].simd;
    const m = samples[f.file].mt;
    return {
      file: f.file,
      shot_enc_simd:  Math.round(median(s.shot_enc)),
      shot_enc_mt:    Math.round(median(m.shot_enc)),
      shot_dec_simd:  Math.round(median(s.shot_dec)),
      shot_dec_mt:    Math.round(median(m.shot_dec)),
      prog_enc_simd:  Math.round(median(s.prog_enc)),
      prog_enc_mt:    Math.round(median(m.prog_enc)),
      prog_first_simd: Math.round(median(s.prog_first)),
      prog_first_mt:   Math.round(median(m.prog_first)),
      prog_final_simd: Math.round(median(s.prog_final)),
      prog_final_mt:   Math.round(median(m.prog_final)),
    };
  });

  // Print per-file
  console.log("\n--- Results (medians) ---");
  for (const r of results) {
    const shotSpd = r.shot_enc_simd > 0 ? (r.shot_enc_simd / Math.max(1, r.shot_enc_mt)).toFixed(2) : "N/A";
    const progSpd = r.prog_enc_simd > 0 ? (r.prog_enc_simd / Math.max(1, r.prog_enc_mt)).toFixed(2) : "N/A";
    console.log(
      `  ${r.file}\n` +
      `    shot: enc simd=${r.shot_enc_simd}ms mt=${r.shot_enc_mt}ms (${shotSpd}x)  dec simd=${r.shot_dec_simd}ms mt=${r.shot_dec_mt}ms\n` +
      `    prog: enc simd=${r.prog_enc_simd}ms mt=${r.prog_enc_mt}ms (${progSpd}x)  first simd=${r.prog_first_simd}ms mt=${r.prog_first_mt}ms`
    );
  }

  const n = results.length;
  const avg = (fn) => Math.round(results.reduce((s, r) => s + fn(r), 0) / n);
  const avgShotEncSimd  = avg(r => r.shot_enc_simd);
  const avgShotEncMt    = avg(r => r.shot_enc_mt);
  const avgShotDecSimd  = avg(r => r.shot_dec_simd);
  const avgShotDecMt    = avg(r => r.shot_dec_mt);
  const avgProgEncSimd  = avg(r => r.prog_enc_simd);
  const avgProgEncMt    = avg(r => r.prog_enc_mt);
  const avgProgFirstSimd = avg(r => r.prog_first_simd);
  const avgProgFirstMt   = avg(r => r.prog_first_mt);
  const mtShotSpd  = (avgShotEncSimd / Math.max(1, avgShotEncMt)).toFixed(2);
  const mtProgSpd  = (avgProgEncSimd / Math.max(1, avgProgEncMt)).toFixed(2);

  console.log(`\n--- Averages ---`);
  console.log(`  AvgShotEncSimdMs: ${avgShotEncSimd}  AvgShotEncMtMs: ${avgShotEncMt}  (${mtShotSpd}x)`);
  console.log(`  AvgProgEncSimdMs: ${avgProgEncSimd}  AvgProgEncMtMs: ${avgProgEncMt}  (${mtProgSpd}x)`);
  console.log(`  AvgShotDecSimdMs: ${avgShotDecSimd}  AvgShotDecMtMs: ${avgShotDecMt}`);
  console.log(`  AvgProgFirstSimdMs: ${avgProgFirstSimd}  AvgProgFirstMtMs: ${avgProgFirstMt}`);

  // Build toon
  const toonLines = [
    `TestName: StandardEncDecTest - ${batchName}`,
    `RunTimestamp: ${runTimestamp}`,
    `Tier: simd+relaxed-simd-mt`,
    `Rounds: ${N_ROUNDS}`,
    `Source: enc-dec-only`,
    `Target: ${TARGET}`,
    `Quality: 85`,
    `Efforts: 3`,
    "",
    "# System Context & Telemetry",
    `SystemPlatform: ${telemetry?.platform || "Unknown"}`,
    `SystemCpuModel: ${telemetry?.cpuModel || "Unknown"}`,
    `SystemCores: ${telemetry?.cores || "N/A"}`,
    `SystemMemoryFreeGb: ${telemetry?.memoryFreeGb || "N/A"}`,
    `CpuClockCurrentGhz: ${telemetry?.cpuClockCurrentGhz || "N/A"}`,
    `CpuClockMaxGhz: ${telemetry?.cpuClockMaxGhz || "N/A"}`,
    `CpuThrottlingState: ${telemetry?.cpuThrottlingState || "Optimal"}`,
    `CpuTemperatureCelsius: ${telemetry?.cpuTemperatureCelsius || "N/A"}`,
    "",
    "# Aggregates",
    `AvgShotEncSimdMs: ${avgShotEncSimd}`,
    `AvgShotEncMtMs: ${avgShotEncMt}`,
    `AvgShotDecSimdMs: ${avgShotDecSimd}`,
    `AvgShotDecMtMs: ${avgShotDecMt}`,
    `AvgProgEncSimdMs: ${avgProgEncSimd}`,
    `AvgProgEncMtMs: ${avgProgEncMt}`,
    `AvgProgFirstSimdMs: ${avgProgFirstSimd}`,
    `AvgProgFirstMtMs: ${avgProgFirstMt}`,
    `MtShotEncSpeedupX: ${mtShotSpd}`,
    `MtProgEncSpeedupX: ${mtProgSpd}`,
    "",
    "---",
    `runs[${n}]{file|shot_enc_simd_ms|shot_enc_mt_ms|shot_dec_simd_ms|shot_dec_mt_ms|prog_enc_simd_ms|prog_enc_mt_ms|prog_first_simd_ms|prog_first_mt_ms}:`,
    ...results.map(r =>
      `  ${r.file} | ${r.shot_enc_simd} | ${r.shot_enc_mt} | ${r.shot_dec_simd} | ${r.shot_dec_mt} | ${r.prog_enc_simd} | ${r.prog_enc_mt} | ${r.prog_first_simd} | ${r.prog_first_mt}`
    ),
  ];

  const toonString = toonLines.join("\n");
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const OUT_DIR = join(scriptDir, "docs", "outputs", "StandardEncDecTest");
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const stamp = runTimestamp.replace(/[:.]/g, "-");
  const outPath = join(OUT_DIR, `${stamp}-StandardEncDecTest-${batchName}.toon`);
  writeFileSync(outPath, toonString);
  console.log(`\n✅ TOON written: ${outPath}\n`);
}

const _guard = setTimeout(() => { process.exit(1); }, 5 * 60 * 1000);
_guard.unref();

main().then(() => {
  clearTimeout(_guard);
  setTimeout(() => process.exit(0), 1000);
}).catch(err => {
  clearTimeout(_guard);
  console.error("StandardEncDecTest failed:", err);
  setTimeout(() => process.exit(1), 500);
});
