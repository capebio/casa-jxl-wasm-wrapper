
import { execSync, spawn } from 'child_process';
import os from 'os';

function runSystemTelemetry() {
  console.log('\n=========================================');
  console.log('💻 SYSTEM TELEMETRY & HARDWARE SENTINEL');
  console.log('=========================================');

  const totalMemGb = (os.totalmem() / (1024 ** 3)).toFixed(1);
  const freeMemGb = (os.freemem() / (1024 ** 3)).toFixed(1);
  const nodeMemMb = (process.memoryUsage().heapUsed / (1024 ** 2)).toFixed(1);
  
  let telemetry = {
    platform: `${process.platform} (${process.arch})`,
    cpuModel: os.cpus()[0]?.model || 'Unknown',
    cores: os.cpus().length,
    memoryFreeGb: freeMemGb,
    memoryTotalGb: totalMemGb,
    nodeHeapMb: nodeMemMb,
    cpuLoadPct: 'N/A',
    cpuClockGhz: 'N/A',
    cpuMaxClockGhz: 'N/A',
    cpuThrottlingPct: '100.0',
    cpuThrottlingState: 'Optimal (Maximum Performance)'
  };

  console.log(`  🧠 OS Memory:     ${freeMemGb} GB Free / ${totalMemGb} GB Total`);
  console.log(`  📦 Node Heap:     ${nodeMemMb} MB Active`);

  if (process.platform === 'win32') {
    try {
      const psCommand = 'powershell.exe -NoProfile -Command "Get-CimInstance -ClassName Win32_Processor | Select-Object CurrentClockSpeed, MaxClockSpeed, LoadPercentage | ConvertTo-Json"';
      const output = execSync(psCommand, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
      const cpuData = JSON.parse(output);
      const data = Array.isArray(cpuData) ? cpuData[0] : cpuData;

      if (data && data.MaxClockSpeed) {
        const currentSpeedGhz = (data.CurrentClockSpeed / 1000).toFixed(2);
        const maxSpeedGhz = (data.MaxClockSpeed / 1000).toFixed(2);
        const throttleRatio = data.CurrentClockSpeed / data.MaxClockSpeed;
        
        let throttleState = 'Optimal (Maximum Performance)';
        if (throttleRatio < 0.95) {
          throttleState = `⚠️ Throttled / Power-Saving (${(throttleRatio * 100).toFixed(1)}% of Max Speed)`;
        }

        telemetry.cpuLoadPct = data.LoadPercentage;
        telemetry.cpuClockGhz = currentSpeedGhz;
        telemetry.cpuMaxClockGhz = maxSpeedGhz;
        telemetry.cpuThrottlingPct = (throttleRatio * 100).toFixed(1);
        telemetry.cpuThrottlingState = throttleState;

        console.log(`  🔥 CPU Active Load: ${data.LoadPercentage}%`);
        console.log(`  ⏱️ CPU Clock Speed: ${currentSpeedGhz} GHz (Max: ${maxSpeedGhz} GHz)`);
        console.log(`  ⚡ Throttling State: ${throttleState}`);
      }
    } catch (err) {
      console.log(`  ⚠️  Hardware sensor query failed (PowerShell/CIM blocked)`);
    }
  } else {
    console.log(`  ℹ️  Detailed throttling sensors only implemented for win32`);
  }
  console.log('=========================================\n');
  return telemetry;
}



import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { Worker as NodeWorker } from "node:worker_threads";
import sharp from "sharp";
import { buildGraphAggregateHtml, buildGraphHistory } from "./benchmark/standard-multifile-history-graph.mjs";
import { consolidateBenchmarkHistory } from "./benchmark/benchmark-history-conversion.mjs";
import { assessSeamComparison } from "./benchmark/seam-comparison-threshold.mjs";
import { buildGraphBrowserLaunchPlan, chooseGraphBrowser, getNextGraphBrowserLaunchMethod } from "./benchmark/graph-browser-launcher.mjs";

// 1. Browser-like Worker Shim for Node.js thread context
class BrowserLikeWorker {
  #worker;
  #onmessage = null;
  #onerror = null;

  constructor(url, options = {}) {
    const workerUrl = url instanceof URL ? url.href : String(url);
    this.#worker = new NodeWorker(new URL("./jxl-worker-shim.mjs", import.meta.url), {
      workerData: { url: workerUrl, name: options.name ?? "" },
    });
    this.#worker.on("message", (data) => this.#onmessage?.({ data }));
    this.#worker.on("error", (error) => this.#onerror?.(error));
  }

  postMessage(message, transfer) { this.#worker.postMessage(message, transfer); }
  terminate() { return this.#worker.terminate(); }
  set onmessage(handler) { this.#onmessage = handler; }
  get onmessage() { return this.#onmessage; }
  set onerror(handler) { this.#onerror = handler; }
  get onerror() { return this.#onerror; }
}

globalThis.Worker = BrowserLikeWorker;

// 2. Initialize WASM Raw Converter
import initRaw, {
  downscale_rgb,
  process_orf_with_flags,
  process_cr2_with_flags,
  process_dng_with_flags,
  rgb_to_rgba,
} from "./pkg/raw_converter_wasm.js";

const {
  createDecoder,
  createEncoder,
  encodeRgba8Pyramid,
  encodeTileContainerRgba8,
  decodeTileContainerRegionRgba8,
  setForcedTier
} = await import("./packages/jxl-wasm/dist/index.js");

await initRaw({ module_or_path: readFileSync(new URL("./pkg/raw_converter_wasm_bg.wasm", import.meta.url)) });



// 3. Resolve Standard Test Files (2 of each format: ORF, CR2, DNG, JPG)
const TEST_ROOT = String.raw`C:\Foo\raw-converter\tests`;
const GOB_ROOT = String.raw`C:\995\2026-02-20 Gobabeb To Windhoek`;
const TIMING_SOURCE = String.raw`.timing-source`;

const FILES_CONFIG = [
  // --- JPG formats ---
  { name: "small_file.jpg", paths: [join(TEST_ROOT, "small_file.jpg")] },
  { name: "P1110226 windows.jpg", paths: [join(TEST_ROOT, "P1110226 windows.jpg")] },
  // --- DNG formats ---
  {
    name: "PXL_20260527_180319603.RAW-02.ORIGINAL.dng",
    paths: [
      join(TEST_ROOT, "PXL_20260527_180319603.RAW-02.ORIGINAL.dng"),
      join(TIMING_SOURCE, "PXL_20260527_180319603.RAW-02.ORIGINAL.dng")
    ]
  },
  { name: "PXL_20260501_093507165.RAW-02.ORIGINAL.dng", paths: [join(TEST_ROOT, "PXL_20260501_093507165.RAW-02.ORIGINAL.dng")] },
  // --- ORF formats ---
  { name: "P1110226.ORF", paths: [join(TEST_ROOT, "P1110226.ORF")] },
  { name: "P2200474.ORF", paths: [join(GOB_ROOT, "P2200474.ORF")] },
  // --- CR2 formats ---
  { name: "_MG_1750.CR2", paths: [join(TEST_ROOT, "_MG_1750.CR2")] },
  { name: "ADH 1248.CR2", paths: [join(TEST_ROOT, "ADH 1248.CR2")] }
];

const TARGET = 1920;
const OUTPUT_FULL_RGB = 1;
const PROCESS_ARGS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Number.NaN, Number.NaN, 0, 0];

// 4. Helper to ensure correct Buffer extraction
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

// 5. JXL Encoding Helper (Progressive or One-shot)
async function encodeJxl(rgba, width, height, isProgressive) {
  const encoder = createEncoder({
    format: "rgba8", width, height, hasAlpha: false,
    iccProfile: null, exif: null, xmp: null,
    distance: 1.0, quality: 85, effort: 3,
    progressive: isProgressive, progressiveFlavor: "ac", previewFirst: false,
    chunked: true,
  });
  const chunks = [];
  const chunkTask = (async () => {
    for await (const chunk of encoder.chunks()) {
      chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    }
  })();
  const t0 = performance.now();
  await encoder.pushPixels(exactBuffer(rgba));
  await encoder.finish();
  await chunkTask;
  await encoder.dispose();
  const ms = performance.now() - t0;
  return { bytes: concatChunks(chunks), ms };
}

async function encodeJxlVariant(rgba, width, height, extra = {}) {
  const encoder = createEncoder({
    format: "rgba8", width, height, hasAlpha: false,
    iccProfile: null, exif: null, xmp: null,
    distance: 1.0, quality: 85, effort: 3,
    progressive: false, progressiveFlavor: "ac", previewFirst: false,
    chunked: true,
    ...extra,
  });
  const chunks = [];
  const chunkTask = (async () => {
    for await (const chunk of encoder.chunks()) {
      chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    }
  })();
  const t0 = performance.now();
  await encoder.pushPixels(exactBuffer(rgba));
  await encoder.finish();
  await chunkTask;
  await encoder.dispose();
  const ms = performance.now() - t0;
  return { bytes: concatChunks(chunks), ms };
}

// 6. JXL Decoding Helper with optional ROI region
async function decodeJxl(jxlBytes, isProgressive, options = {}) {
  const decoder = createDecoder({
    format: "rgba8",
    progressionTarget: options.progressionTarget ?? "final",
    emitEveryPass: options.emitEveryPass ?? isProgressive,
    progressiveDetail: options.progressiveDetail ?? (isProgressive ? "passes" : "none"),
    downsample: options.downsample ?? 1,
    preserveIcc: false, preserveMetadata: false,
    region: options.region ?? null,
  });

  let passCount = 0;
  let firstFrameMs = null;
  let decodedPixels = null;
  const t0 = performance.now();
  try {
    const evTask = (async () => {
      for await (const ev of decoder.events()) {
        if (ev.type === "progress" || ev.type === "final") {
          passCount++;
          if (ev.pixels) decodedPixels = ev.pixels;
          if (firstFrameMs === null) firstFrameMs = performance.now() - t0;
        }
        else if (ev.type === "error") throw new Error(`${ev.code}: ${ev.message}`);
      }
    })();
    await decoder.push(exactBuffer(jxlBytes));
    await decoder.close();
    await evTask;


  } finally {
    try { await decoder.dispose(); } catch (_) {}
  }
  const ms = performance.now() - t0;
  return { ms, firstFrameMs: firstFrameMs ?? ms, passCount, pixels: decodedPixels };
}

// Streaming chunked-input progressive decode simulation (covers test_1 / progressive-timing-benchmark chunked steps)
async function timedChunkedInputDecode(jxlBytes, steps, isProgressive, options = {}) {
  const decoder = createDecoder({
    format: "rgba8",
    progressionTarget: options.progressionTarget ?? "final",
    emitEveryPass: options.emitEveryPass ?? isProgressive,
    progressiveDetail: options.progressiveDetail ?? (isProgressive ? "passes" : "none"),
    downsample: options.downsample ?? 1,
    preserveIcc: false, preserveMetadata: false,
    region: options.region ?? null,
  });
  let firstFrameMs = null;
  let passCount = 0;
  const t0 = performance.now();
  try {
    const evTask = (async () => {
      for await (const ev of decoder.events()) {
        if (ev.type === "progress" || ev.type === "final") {
          passCount++;
          if (firstFrameMs === null) firstFrameMs = performance.now() - t0;
        } else if (ev.type === "error") {
          // ignore truncation for partial pushes in sim
        }
      }
    })();
    const src = (jxlBytes instanceof Uint8Array) ? jxlBytes : new Uint8Array(jxlBytes);
    const chunkSize = Math.ceil(src.byteLength / steps);
    for (let i = 0; i < steps; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, src.byteLength);
      if (end > start) await decoder.push(exactBuffer(src.subarray(start, end)));
    }
    await decoder.close();
    await evTask;
  } finally {
    try { await decoder.dispose(); } catch (_) {}
  }
  const ms = performance.now() - t0;
  return { ms, firstFrameMs: firstFrameMs ?? ms, passCount };
}

// 7. Benchmark Suite Entrypoint
async function main() {
  globalThis.systemTelemetry = runSystemTelemetry();
  let finalEncMetrics = {};
  const batchName = process.argv[2] || process.env.SPEEDTEST_BATCH || "general";
  const runTimestamp = new Date().toISOString();
  
  console.log(`=========================================`);
  console.log(`🚀 RUNNING STANDARDIZED SPEEDTEST WITH DEEP DIAGNOSTICS`);
  console.log(`   Batch Name: ${batchName}`);
  console.log(`   Timestamp:  ${runTimestamp}`);
  console.log(`=========================================\n`);

  const loadedFiles = [];

  // --- 7.1 Pre-load and scale all assets (RAW & JPG decoding) ---
  console.log(`--- [1/6] Pre-loading & Scaling Assets ---`);
  for (const config of FILES_CONFIG) {
    let resolvedPath = null;
    for (const path of config.paths) {
      if (existsSync(path)) { resolvedPath = path; break; }
    }
    if (!resolvedPath) {
      console.warn(`⚠️  Skipping missing benchmark file: ${config.name}`);
      continue;
    }

    const ext = extname(resolvedPath).toLowerCase();
    const raw = new Uint8Array(readFileSync(resolvedPath));
    const tRawStart = performance.now();
    let rgb, srcW, srcH;
    let rawDecompress = 0, rawDemosaic = 0, rawTonemap = 0, rawOrient = 0;

    if (ext === ".jpg" || ext === ".jpeg") {
      const { data, info } = await sharp(resolvedPath).raw().toBuffer({ resolveWithObject: true });
      rgb = data; srcW = info.width; srcH = info.height;
    } else {
      let decoded;
      if (ext === ".orf" || ext === ".raw") decoded = process_orf_with_flags(raw, OUTPUT_FULL_RGB, ...PROCESS_ARGS);
      else if (ext === ".cr2") decoded = process_cr2_with_flags(raw, OUTPUT_FULL_RGB, ...PROCESS_ARGS);
      else if (ext === ".dng") decoded = process_dng_with_flags(raw, OUTPUT_FULL_RGB, ...PROCESS_ARGS);
      rawDecompress = decoded.decompress_ms ?? 0;
      rawDemosaic = decoded.demosaic_ms ?? 0;
      rawTonemap = decoded.tonemap_ms ?? 0;
      rawOrient = decoded.orient_ms ?? 0;
      rgb = decoded.take_rgb(); srcW = decoded.width; srcH = decoded.height; decoded.free();
    }
    const rawMs = performance.now() - tRawStart;

    const tScaleStart = performance.now();
    const longEdge = Math.max(srcW, srcH);
    const scale = longEdge > TARGET ? TARGET / longEdge : 1;
    const tgtW = Math.round(srcW * scale);
    const tgtH = Math.round(srcH * scale);
    const rgba = scale < 1 ? rgb_to_rgba(downscale_rgb(rgb, srcW, srcH, tgtW, tgtH)) : rgb_to_rgba(rgb);
    const scaleMs = performance.now() - tScaleStart;

    console.log(`  Loaded ${basename(resolvedPath)}: decode=${Math.round(rawMs)}ms scale=${Math.round(scaleMs)}ms (${tgtW}x${tgtH})`);
    loadedFiles.push({ file: basename(resolvedPath), rgba, tgtW, tgtH, rawMs, scaleMs, rawDecompress, rawDemosaic, rawTonemap, rawOrient });
  }
  console.log("");

  // Helper to run sequential benchmark loop on a specific JXL tier
  async function runSequentialSuite(tierName) {
    console.log(`--- Run sequential JXL benchmarks on tier [${tierName}] ---`);
    setForcedTier(tierName);
    const results = [];

    for (const f of loadedFiles) {
      // Progressive JXL Benchmarks
      const progEnc = await encodeJxl(f.rgba, f.tgtW, f.tgtH, true);
      const progDec = await decodeJxl(progEnc.bytes, true);

      // One-shot JXL Benchmarks
      const shotEnc = await encodeJxl(f.rgba, f.tgtW, f.tgtH, false);
      const shotDec = await decodeJxl(shotEnc.bytes, false);

      // Pyramid JXL Benchmarks
      let pyrEncMs = 0;
      let pyrDecTotMs = 0;
      let pyrLevelsCount = 0;
      if (typeof encodeRgba8Pyramid === "function") {
        const tPyrEnc = performance.now();
        const levels = await encodeRgba8Pyramid(f.rgba, f.tgtW, f.tgtH, {
          fullDistance: 1.0,
          sidecarSizes: [256, 512, 1024, 2048],
          sidecarDistances: [1.45, 1.45, 1.45, 1.45],
          effort: 3,
          hasAlpha: false,
        });
        pyrEncMs = performance.now() - tPyrEnc;
        pyrLevelsCount = levels.length;

        for (const lvl of levels) {
          const tDecStart = performance.now();
          await decodeJxl(lvl.data, false);
          pyrDecTotMs += performance.now() - tDecStart;
        }
      }

      // --- Additional timings pulled from benchmark/*.mjs (test_1, progressive-timing-benchmark, timing-tests, targeted, test_1x sweeps) ---
      // Rich decode variants (ds2, region crops) for prog vs oneshot
      const regionEx = { x: Math.floor(f.tgtW * 0.25), y: Math.floor(f.tgtH * 0.25), w: Math.floor(f.tgtW * 0.5), h: Math.floor(f.tgtH * 0.5) };
      const progDs2 = await decodeJxl(progEnc.bytes, true, { downsample: 2 });
      const progRegion = await decodeJxl(progEnc.bytes, true, { region: regionEx });
      const shotDs2 = await decodeJxl(shotEnc.bytes, false, { downsample: 2 });
      const shotRegion = await decodeJxl(shotEnc.bytes, false, { region: regionEx });
      // Chunked-input streaming sim for progressive (4 steps)
      const progChunked = await timedChunkedInputDecode(progEnc.bytes, 4, true);
      // Encode variants for modular / other options coverage (timing-tests, test_14, test_17 etc)
      let modProgEncMs = 0, modProgSize = 0;
      let photonEncMs = 0, photonSize = 0;
      try {
        const modP = await encodeJxlVariant(f.rgba, f.tgtW, f.tgtH, { progressive: true, modular: 1 });
        modProgEncMs = modP.ms; modProgSize = modP.bytes.byteLength;
      } catch (_) {}
      try {
        const pho = await encodeJxlVariant(f.rgba, f.tgtW, f.tgtH, { progressive: true, photonNoiseIso: 800 });
        photonEncMs = pho.ms; photonSize = pho.bytes.byteLength;
      } catch (_) {}

      results.push({
        file: f.file,
        prog_enc_ms: Math.round(progEnc.ms),
        prog_first_ms: Math.round(progDec.firstFrameMs),
        prog_final_ms: Math.round(progDec.ms),
        prog_passes: progDec.passCount,
        prog_size: progEnc.bytes.byteLength,
        shot_enc_ms: Math.round(shotEnc.ms),
        shot_dec_ms: Math.round(shotDec.ms),
        shot_size: shotEnc.bytes.byteLength,
        pyr_enc_ms: Math.round(pyrEncMs),
        pyr_dec_tot_ms: Math.round(pyrDecTotMs),
        pyr_levels: pyrLevelsCount,
        shot_bytes: shotEnc.bytes,
        // additional from benchmark sweeps
        prog_ds2_first_ms: Math.round(progDs2.firstFrameMs),
        prog_ds2_final_ms: Math.round(progDs2.ms),
        prog_region_ms: Math.round(progRegion.ms),
        shot_ds2_ms: Math.round(shotDs2.ms),
        shot_region_ms: Math.round(shotRegion.ms),
        prog_chunked4_first_ms: Math.round(progChunked.firstFrameMs),
        prog_chunked4_final_ms: Math.round(progChunked.ms),
        mod_prog_enc_ms: Math.round(modProgEncMs),
        photon_prog_enc_ms: Math.round(photonEncMs),
      });
      console.log(`  ➔ ${f.file}: prog_enc=${Math.round(progEnc.ms)}ms first_paint=${Math.round(progDec.firstFrameMs)}ms final_paint=${Math.round(progDec.ms)}ms | shot_dec=${Math.round(shotDec.ms)}ms | pyr_dec=${Math.round(pyrDecTotMs)}ms | +ds2/region/chunked/mod/photon variants`);
    }
    console.log("");
    return results;
  }

  // --- 7.2 Run Single-Threaded sequential benchmarks (simd) ---
  console.log(`--- [2/6] Executing Single-Threaded Sequential (simd) ---`);
  const simdResults = await runSequentialSuite("simd");

  // --- 7.3 Run Multi-Threaded sequential benchmarks (relaxed-simd-mt) ---
  console.log(`--- [3/6] Executing Multi-Threaded Sequential (relaxed-simd-mt) ---`);
  const mtResults = await runSequentialSuite("relaxed-simd-mt");

  // --- 7.4 Run Multiple Workers parallel benchmark (simd Parallel) ---
  console.log(`--- [4/6] Executing Parallel Concurrency (Multiple Workers in Parallel) ---`);
  setForcedTier("simd");

  const tParallelStart = performance.now();
  const parallelDecResults = await Promise.all(
    simdResults.map(async (r) => {
      const tLvlDec = performance.now();
      await decodeJxl(r.shot_bytes, false);
      return performance.now() - tLvlDec;
    })
  );
  const parallelWallMs = Math.round(performance.now() - tParallelStart);
  const sequentialDecSum = simdResults.reduce((sum, r) => sum + r.shot_dec_ms, 0);
  const throughputGain = (sequentialDecSum / parallelWallMs).toFixed(2);

  console.log(`  Sequential Sum of Decodes: ${sequentialDecSum}ms`);
  console.log(`  Parallel Wall-Clock Time:  ${parallelWallMs}ms`);
  console.log(`  🚀 Multi-Worker Speedup:   ${throughputGain}x (Parallel vs Sequential throughput)\n`);




  // =========================================================================
  // --- 7.5 DEEP DIAGNOSTIC 1: Transferable vs Structured Clone Cost (U1) ---
  // =========================================================================
  console.log(`--- [5/6] Diagnostic U1: Transferable vs. Structured Clone (Copy) Cost ---`);
  
  // Create an artificial worker to act as the reflection postMessage target
  const dummyWorkerUrl = new URL("./jxl-worker-shim.mjs", import.meta.url).href;
  const dummyWorker = new NodeWorker(new URL("./jxl-worker-shim.mjs", import.meta.url), {
    workerData: { url: dummyWorkerUrl, name: "dummy-diag" },
  });

  const sizesToTest = [
    { label: "1MB", bytes: 1024 * 1024 },
    { label: "10MB", bytes: 10 * 1024 * 1024 },
    { label: "30MB (Typical 1920 RGBA)", bytes: 1920 * 1440 * 4 } // ~11MB
  ];

  const diagTransferResults = [];
  for (const s of sizesToTest) {
    // Measure structured clone (Copy)
    const bufCopy = new ArrayBuffer(s.bytes);
    const tCopyStart = performance.now();
    // Simulate Structured Clone (which serializes/clones across thread boundary)
    const cloneBytes = structuredClone(bufCopy);
    const copyMs = performance.now() - tCopyStart;

    // Measure Transfer (moving ownership zero-copy)
    const bufTransfer = new ArrayBuffer(s.bytes);
    const tTransferStart = performance.now();
    // In Node.js worker_threads, we move buffer ownership using the transferList option on postMessage
    dummyWorker.postMessage({ cmd: "noop", buffer: bufTransfer }, [bufTransfer]);
    const transferMs = performance.now() - tTransferStart;

    diagTransferResults.push({
      label: s.label,
      bytes: s.bytes,
      copyMs: parseFloat(copyMs.toFixed(3)),
      transferMs: parseFloat(transferMs.toFixed(3)),
      ratio: (copyMs / Math.max(0.001, transferMs)).toFixed(1)
    });
    console.log(`  ➔ Size ${s.label}: structured_clone=${copyMs.toFixed(3)}ms | transferable_postMessage=${transferMs.toFixed(3)}ms (Transfer is ${diagTransferResults[diagTransferResults.length-1].ratio}x faster)`);
  }
  await dummyWorker.terminate();
  console.log("");


  // =========================================================================
  // --- 7.6 DEEP DIAGNOSTIC 2: JXTC Tiled Container ROI vs. Monolithic ROI ---
  // =========================================================================
  console.log(`--- [6/6] Diagnostic G3: Real JXTC Tiled Container Region of Interest (ROI) Decodes ---`);
  
  const diagRoiResults = [];
  // Use a large file from our config to get meaningful ROI measurements
  const largeFileIndex = loadedFiles.findIndex(f => f.file === "PXL_20260501_093507165.RAW-02.ORIGINAL.dng" || f.file === "P1110226.ORF");
  
  if (largeFileIndex !== -1) {
    const f = loadedFiles[largeFileIndex];
    
    // --- 1. Encode into a REAL JXTC Tiled Container (256px tile size) ---
    console.log(`  Encoding ${f.file} into JXTC Tiled Container (tileSize=256)...`);
    const encMetrics = {};
    const tJxtcEnc = performance.now();
    const jxtcBytes = await encodeTileContainerRgba8(exactBuffer(f.rgba), f.tgtW, f.tgtH, {
      tileSize: 256,
      distance: 1.0, // Quality 85
      effort: 3,
      onMetric: (name, val) => {
        encMetrics[name] = val;
      }
    });
    const jxtcEncMs = performance.now() - tJxtcEnc;
    globalThis.finalEncMetrics = encMetrics; // Save for TOON serialization
    console.log(`    ➔ JXTC Encoding complete: size=${(jxtcBytes.byteLength / 1024).toFixed(0)}KB | time=${Math.round(jxtcEncMs)}ms`);
    console.log(`      ⚡ Granular FFI Sub-timers:`);
    console.log(`         - Input Prep:   ${(encMetrics.enc_input_prep || 0).toFixed(1)}ms`);
    console.log(`         - Heap Malloc:  ${(encMetrics.enc_malloc || 0).toFixed(1)}ms`);
    console.log(`         - Heap Copy:    ${(encMetrics.enc_heap_set || 0).toFixed(1)}ms`);
    console.log(`         - Core Compress: ${(encMetrics.enc_wasm_encode || 0).toFixed(1)}ms (C++ libjxl)`);
    console.log(`         - Buffer Read:  ${(encMetrics.enc_buffer_read || 0).toFixed(1)}ms`);
    console.log(`         - Heap Free:    ${(encMetrics.enc_free || 0).toFixed(1)}ms`);
    
    const initOverhead = (encMetrics.enc_input_prep || 0) + (encMetrics.enc_malloc || 0) + (encMetrics.enc_heap_set || 0);
    const teardownOverhead = (encMetrics.enc_buffer_read || 0) + (encMetrics.enc_free || 0);
    console.log(`         🚀 Boundary Setup Overhead:    ${initOverhead.toFixed(1)}ms`);
    console.log(`         🚀 Boundary Teardown Overhead: ${teardownOverhead.toFixed(1)}ms`);

    // Target a central 512x512 ROI region
    const roiW = 512;
    const roiH = 512;
    const roiX = Math.round((f.tgtW - roiW) / 2);
    const roiY = Math.round((f.tgtH - roiH) / 2);

    const region = { x: roiX, y: roiY, w: roiW, h: roiH };

    console.log(`[DEBUG G3] f.tgtW=${f.tgtW}, f.tgtH=${f.tgtH}, roiX=${roiX}, roiY=${roiY}, roiW=${roiW}, roiH=${roiH}`);

    // 2. Decode unified ROI on MONOLITHIC JXL
    const monolithicBytes = simdResults[largeFileIndex].shot_bytes;
    const tMonRoiStart = performance.now();
    const monRoiRes = await decodeJxl(monolithicBytes, false, { region });
    const monRoiMs = performance.now() - tMonRoiStart;

    // 3. Decode unified ROI on REAL JXTC Tiled Container (seek-aware crop)
    const tJxtcRoiStart = performance.now();
    const jxtcRoiRes = await decodeTileContainerRegionRgba8(jxtcBytes, { x: roiX, y: roiY, w: roiW, h: roiH });
    const jxtcRoiMs = performance.now() - tJxtcRoiStart;

    // --- P-4 Seam Test Correctness Verification ---
    console.log(`\n  [P-4 Seam Test] Comparing JXTC ROI vs. Monolithic ROI pixel-by-pixel...`);
    const monPixels = monRoiRes.pixels; // Uint8Array of monolithic ROI pixels
    const jxtcPixels = jxtcRoiRes.pixels; // Uint8Array of JXTC ROI pixels

    if (!monPixels) {
      console.error(`  ⚠️  [P-4 Seam Test] Warning: Monolithic ROI did not return pixel array to compare.`);
    } else if (monPixels.length !== jxtcPixels.length) {
      console.error(`  ❌ FAIL: [P-4 Seam Test] Buffer lengths differ! Monolithic=${monPixels.length} | JXTC=${jxtcPixels.length}`);
    } else {
      let mismatches = 0;
      let maxDiff = 0;
      for (let i = 0; i < monPixels.length; i++) {
        if (monPixels[i] !== jxtcPixels[i]) {
          mismatches++;
          const diff = Math.abs(monPixels[i] - jxtcPixels[i]);
          if (diff > maxDiff) maxDiff = diff;
        }
      }
        if (mismatches === 0) {
          console.log(`  ✅ SUCCESS: [P-4 Seam Test] Passed! JXTC Tiled Region Decode is 100% pixel-exact byte-identical to Monolithic ROI Decode! (0 byte mismatches, 0 drift)`);
        } else {
          const seamAssessment = assessSeamComparison({
            mismatches,
            totalBytes: monPixels.length,
            maxDiff,
          });
          if (seamAssessment.shouldFail) {
            console.error(`  ❌ FAIL: [P-4 Seam Test] Failed! ${seamAssessment.message}`);
          } else {
            console.warn(`  ⚠️  [P-4 Seam Test] ${seamAssessment.message}`);
          }
        }
      }

    // 4. 4-Tile Split Decode on JXTC (decompressing individual tiles independently)
    const tiles = [
      { x: roiX, y: roiY, w: 256, h: 256 },
      { x: roiX + 256, y: roiY, w: 256, h: 256 },
      { x: roiX, y: roiY + 256, w: 256, h: 256 },
      { x: roiX + 256, y: roiY + 256, w: 256, h: 256 }
    ];

    const tTiledSeqStart = performance.now();
    for (const tile of tiles) {
      await decodeTileContainerRegionRgba8(jxtcBytes, { x: tile.x, y: tile.y, w: tile.w, h: tile.h });
    }
    const tiledSeqMs = performance.now() - tTiledSeqStart;

    // 5. 4-Tile Parallel Decode on JXTC (Promise.all)
    const tTiledParStart = performance.now();
    await Promise.all(
      tiles.map(async (tile) => {
        return await decodeTileContainerRegionRgba8(jxtcBytes, { x: tile.x, y: tile.y, w: tile.w, h: tile.h });
      })
    );
    const tiledParMs = performance.now() - tTiledParStart;

    // 6. --- Full-Size Decoding Benchmarks (Tiled vs Monolithic) ---
    console.log(`\n  Benchmarking FULL-SIZE Decodes on ${f.file}...`);
    const monolithicFullMs = simdResults[largeFileIndex].shot_dec_ms;

    // Unified Full JXTC Decode (1 call)
    const tJxtcFullStart = performance.now();
    await decodeTileContainerRegionRgba8(jxtcBytes, { x: 0, y: 0, w: f.tgtW, h: f.tgtH });
    const jxtcFullMs = performance.now() - tJxtcFullStart;

    // Compute all tiles for the entire image (256px grid)
    const fullTiles = [];


    const tileSize = 256;
    for (let ty = 0; ty < Math.ceil(f.tgtH / tileSize); ty++) {
      for (let tx = 0; tx < Math.ceil(f.tgtW / tileSize); tx++) {
        const tw = Math.min(tileSize, f.tgtW - tx * tileSize);
        const th = Math.min(tileSize, f.tgtH - ty * tileSize);
        fullTiles.push({ x: tx * tileSize, y: ty * tileSize, w: tw, h: th });
      }
    }

    // Sequential All-Tile JXTC Decode (Sequential Stitch)
    const tFullTiledSeqStart = performance.now();
    for (const tile of fullTiles) {
      await decodeTileContainerRegionRgba8(jxtcBytes, { x: tile.x, y: tile.y, w: tile.w, h: tile.h });
    }
    const fullTiledSeqMs = performance.now() - tFullTiledSeqStart;

    // Parallel All-Tile JXTC Decode (Concurrent Workers)
    const tFullTiledParStart = performance.now();
    await Promise.all(
      fullTiles.map(async (tile) => {
        return await decodeTileContainerRegionRgba8(jxtcBytes, { x: tile.x, y: tile.y, w: tile.w, h: tile.h });
      })
    );
    const fullTiledParMs = performance.now() - tFullTiledParStart;

    // 7. --- JXTC Tiled Encoding vs. Monolithic/Single-Shot Encoding ---
    const monolithicEncMs = simdResults[largeFileIndex].shot_enc_ms;

    diagRoiResults.push({
      file: f.file,
      monolithicMs: Math.round(monRoiMs),
      jxtcMs: Math.round(jxtcRoiMs),
      tiledSeqMs: Math.round(tiledSeqMs),
      tiledParMs: Math.round(tiledParMs),
      monolithicFullMs: Math.round(monolithicFullMs),
      jxtcFullMs: Math.round(jxtcFullMs),
      fullTiledSeqMs: Math.round(fullTiledSeqMs),
      fullTiledParMs: Math.round(fullTiledParMs),
      monolithicEncMs: Math.round(monolithicEncMs),
      jxtcEncMs: Math.round(jxtcEncMs),
    });

    console.log(`\n  --- ROI (512x512) CROP TIMINGS ---`);
    console.log(`  ➔ Monolithic ROI Crop Decode (No Tiling):     ${Math.round(monRoiMs)}ms`);
    console.log(`  ➔ Real JXTC Tiled ROI Crop Decode (One Call):  ${Math.round(jxtcRoiMs)}ms (Speedup: ${(monRoiMs / jxtcRoiMs).toFixed(1)}x)`);
    console.log(`  ➔ JXTC Sequential 4-Tile Crop Decodes:        ${Math.round(tiledSeqMs)}ms`);
    console.log(`  ➔ JXTC Parallel 4-Tile Crop Decodes:          ${Math.round(tiledParMs)}ms`);

    console.log(`\n  --- FULL-SIZE (1920px) TIMINGS ---`);
    console.log(`  ➔ Monolithic Full Decode (Standard):          ${Math.round(monolithicFullMs)}ms`);
    console.log(`  ➔ Real JXTC Tiled Full Decode (One Call):     ${Math.round(jxtcFullMs)}ms`);
    console.log(`  ➔ JXTC Sequential All-Tile Decode (Stitch):   ${Math.round(fullTiledSeqMs)}ms`);
    console.log(`  ➔ JXTC Parallel All-Tile Decode (Workers):     ${Math.round(fullTiledParMs)}ms (${fullTiles.length} tiles)`);

    console.log(`\n  --- ENCODING TIMINGS (Tiled vs Monolithic) ---`);
    console.log(`  ➔ Monolithic JXL Encoding Speed:              ${Math.round(monolithicEncMs)}ms`);
    console.log(`  ➔ Real JXTC Tiled Container Encoding Speed:   ${Math.round(jxtcEncMs)}ms (Overhead: +${(jxtcEncMs - monolithicEncMs).toFixed(0)}ms)`);
  } else {
    console.log("  ⚠️  Skipping ROI diagnostics: No large RAW file was loaded.");
  }
  console.log("");

  // --- 7.7 RUN ADDITIONAL TIMINGS from benchmark/*.mjs + examined timings/*.mjs ---
  // Covers permutations, rich decode variants, substage, progressive chunk/stream, sweeps (modular, photon, brotli, quality etc) not in core path.
  // timings/ *.mjs (single-progressive-*.mjs, probe-wasm-tier.mjs) are browser+server launchers for web single-prog page; left as separate (require http://localhost:9000 + playwright).
  // We run limited node-only ones here so their .toon land in timing dir for consolidate+graph.
  console.log(`--- [7/7] Additional timings from benchmark/*.mjs (limited to keep responsive) ---`);
  const addEnvBase = { ...process.env };
  const tried = [];
  function runLimitedBench(script, extraEnv = {}, timeoutMs = 60000) {
    const env = { ...addEnvBase, ...extraEnv };
    const cmd = `node ${script}`;
    tried.push(script);
    try {
      execSync(cmd, { stdio: "ignore", timeout: timeoutMs, env, cwd: process.cwd() });
      console.log(`  ✓ ${script} (limited)`);
      return true;
    } catch (e) {
      const msg = (e && e.message ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 120);
      console.log(`  - ${script} (skipped/partial: ${msg})`);
      return false;
    }
  }
  runLimitedBench("benchmark/timing-tests.mjs", {
    TIMING_RAW_LIMIT: "1", TIMING_JPEG_LIMIT: "1", TIMING_TARGET: "400",
    TIMING_EFFORTS: "3", TIMING_MODES: "std,std+chunked"
  }, 90000);
  runLimitedBench("benchmark/progressive-timing-benchmark.mjs", {
    PT_LIMIT: "1", PT_SIZES: "400", PT_QUALITY: "85", PT_EFFORT: "3", PT_STEPS: "4"
  }, 90000);
  runLimitedBench("benchmark/targeted-wasm-timings.mjs", {
    TEST_RUNS: "1", TEST_SCAN_LIMIT: "1", GOB_SCAN_LIMIT: "0", GOB_OFFENDER_COUNT: "0", TRACE_PROGRESS: "0", TRACE_STAGES: "0"
  }, 60000);
  // A couple of the numbered sweep tests (via their env overrides if present; most default to small via utils)
  runLimitedBench("benchmark/test_14_modular_mode_sweep.mjs", { TEST14_LIMIT: "1" }, 60000);
  runLimitedBench("benchmark/test_11_brotli_effort_sweep.mjs", { /* may honor or use 1 file */ }, 60000);
  console.log(`  (examined also: timings/probe-wasm-tier.mjs, timings/single-progressive-*.mjs — browser CDP paths for lastPasses/passes single-prog metrics)`);
  console.log(`  Additional tried: ${tried.join(", ")}`);
  console.log("");


  // --- 8. Build Combined Modified TOON Format Output ---
  const toonLines = [
    `TestName: StandardMultifileTest - ${batchName}`,
    `RunTimestamp: ${runTimestamp}`,
    `Agent: gemini-cli`,
    `Tier: simd+relaxed-simd-mt`,
    `Source: multi-format`,
    `Target: ${TARGET}`,
    `Quality: 85`,
    `Efforts: 3`,
    `TimeBase: timeBase`,
    "",
    "# System Context & Telemetry",
    `SystemPlatform: ${globalThis.systemTelemetry?.platform || 'Unknown'}`,
    `SystemCpuModel: ${globalThis.systemTelemetry?.cpuModel || 'Unknown'}`,
    `SystemCores: ${globalThis.systemTelemetry?.cores || 'N/A'}`,
    `SystemMemoryFreeGb: ${globalThis.systemTelemetry?.memoryFreeGb || 'N/A'}`,
    `SystemMemoryTotalGb: ${globalThis.systemTelemetry?.memoryTotalGb || 'N/A'}`,
    `NodeHeapActiveMb: ${globalThis.systemTelemetry?.nodeHeapMb || 'N/A'}`,
    `CpuActiveLoadPct: ${globalThis.systemTelemetry?.cpuLoadPct || 'N/A'}`,
    `CpuClockCurrentGhz: ${globalThis.systemTelemetry?.cpuClockGhz || 'N/A'}`,
    `CpuClockMaxGhz: ${globalThis.systemTelemetry?.cpuMaxClockGhz || 'N/A'}`,
    `CpuThrottlingPct: ${globalThis.systemTelemetry?.cpuThrottlingPct || '100.0'}`,
    `CpuThrottlingState: ${globalThis.systemTelemetry?.cpuThrottlingState || 'Optimal'}`,
    "",

    "",
    "---",
    `runs[${loadedFiles.length}]{file|raw_ms|scale_ms|raw_decompress_ms|raw_demosaic_ms|raw_tonemap_ms|prog_enc_simd_ms|prog_enc_mt_ms|prog_first_simd_ms|prog_first_mt_ms|prog_final_simd_ms|prog_final_mt_ms|shot_enc_simd_ms|shot_enc_mt_ms|shot_dec_simd_ms|shot_dec_mt_ms|pyr_enc_simd_ms|pyr_enc_mt_ms|pyr_dec_simd_ms|pyr_dec_mt_ms|prog_ds2_first_simd_ms|prog_ds2_final_simd_ms|prog_region_simd_ms|shot_ds2_simd_ms|shot_region_simd_ms|prog_chunked4_first_simd_ms|mod_prog_enc_simd_ms|photon_prog_enc_simd_ms}:`
  ];

  for (let i = 0; i < loadedFiles.length; i++) {
    const f = loadedFiles[i];
    const s = simdResults[i];
    const m = mtResults[i];
    toonLines.push(`  ${f.file} | ${Math.round(f.rawMs)} | ${Math.round(f.scaleMs)} | ${Math.round(f.rawDecompress||0)} | ${Math.round(f.rawDemosaic||0)} | ${Math.round(f.rawTonemap||0)} | ${s.prog_enc_ms} | ${m.prog_enc_ms} | ${s.prog_first_ms} | ${m.prog_first_ms} | ${s.prog_final_ms} | ${m.prog_final_ms} | ${s.shot_enc_ms} | ${m.shot_enc_ms} | ${s.shot_dec_ms} | ${m.shot_dec_ms} | ${s.pyr_enc_ms} | ${m.pyr_enc_ms} | ${s.pyr_dec_tot_ms} | ${m.pyr_dec_tot_ms} | ${s.prog_ds2_first_ms||0} | ${s.prog_ds2_final_ms||0} | ${s.prog_region_ms||0} | ${s.shot_ds2_ms||0} | ${s.shot_region_ms||0} | ${s.prog_chunked4_first_ms||0} | ${s.mod_prog_enc_ms||0} | ${s.photon_prog_enc_ms||0}`);
  }

  // Compute Averages
  const avgRaw = Math.round(loadedFiles.reduce((s, r) => s + r.rawMs, 0) / loadedFiles.length);
  const avgScale = Math.round(loadedFiles.reduce((s, r) => s + r.scaleMs, 0) / loadedFiles.length);
  const avgRawDecomp = Math.round(loadedFiles.reduce((s, r) => s + (r.rawDecompress||0), 0) / loadedFiles.length);
  const avgRawDemo   = Math.round(loadedFiles.reduce((s, r) => s + (r.rawDemosaic||0), 0) / loadedFiles.length);
  const avgRawTone   = Math.round(loadedFiles.reduce((s, r) => s + (r.rawTonemap||0), 0) / loadedFiles.length);

  const avgProgEncSimd = Math.round(simdResults.reduce((s, r) => s + r.prog_enc_ms, 0) / loadedFiles.length);
  const avgProgEncMt   = Math.round(mtResults.reduce((s, r) => s + r.prog_enc_ms, 0) / loadedFiles.length);
  const avgProgFirstSimd = Math.round(simdResults.reduce((s, r) => s + r.prog_first_ms, 0) / loadedFiles.length);
  const avgProgFirstMt   = Math.round(mtResults.reduce((s, r) => s + r.prog_first_ms, 0) / loadedFiles.length);
  const avgProgFinalSimd = Math.round(simdResults.reduce((s, r) => s + r.prog_final_ms, 0) / loadedFiles.length);
  const avgProgFinalMt   = Math.round(mtResults.reduce((s, r) => s + r.prog_final_ms, 0) / loadedFiles.length);

  const avgShotEncSimd = Math.round(simdResults.reduce((s, r) => s + r.shot_enc_ms, 0) / loadedFiles.length);
  const avgShotEncMt   = Math.round(mtResults.reduce((s, r) => s + r.shot_enc_ms, 0) / loadedFiles.length);
  const avgShotDecSimd = Math.round(simdResults.reduce((s, r) => s + r.shot_dec_ms, 0) / loadedFiles.length);
  const avgShotDecMt   = Math.round(mtResults.reduce((s, r) => s + r.shot_dec_ms, 0) / loadedFiles.length);

  const avgPyrEncSimd = Math.round(simdResults.reduce((s, r) => s + r.pyr_enc_ms, 0) / loadedFiles.length);
  const avgPyrEncMt   = Math.round(mtResults.reduce((s, r) => s + r.pyr_enc_ms, 0) / loadedFiles.length);
  const avgPyrDecSimd = Math.round(simdResults.reduce((s, r) => s + r.pyr_dec_tot_ms, 0) / loadedFiles.length);
  const avgPyrDecMt   = Math.round(mtResults.reduce((s, r) => s + r.pyr_dec_tot_ms, 0) / loadedFiles.length);

  // additional avgs (simd-focused coverage for benchmark/ missing timings)
  const avgProgDs2First = Math.round(simdResults.reduce((s, r) => s + (r.prog_ds2_first_ms||0), 0) / loadedFiles.length);
  const avgProgChunkedFirst = Math.round(simdResults.reduce((s, r) => s + (r.prog_chunked4_first_ms||0), 0) / loadedFiles.length);
  const avgModProgEnc = Math.round(simdResults.reduce((s, r) => s + (r.mod_prog_enc_ms||0), 0) / loadedFiles.length);
  const avgPhotonProgEnc = Math.round(simdResults.reduce((s, r) => s + (r.photon_prog_enc_ms||0), 0) / loadedFiles.length);

  toonLines.push("", "# Aggregates");
  toonLines.push(`TotalRecords: ${loadedFiles.length}`);
  toonLines.push(`MultiWorkerSequentialDecSumMs: ${sequentialDecSum}`);
  toonLines.push(`MultiWorkerParallelWallMs: ${parallelWallMs}`);
  toonLines.push(`MultiWorkerSpeedupRatio: ${throughputGain}`);

  toonLines.push("", "# Diagnostics U1 (Transfer vs Structured Clone Copy ms)");
  for (const t of diagTransferResults) {
    toonLines.push(`  TransferSize_${t.label}: clone_copy=${t.copyMs}ms | transferable_transfer=${t.transferMs}ms | transfer_speedup=${t.ratio}x`);
  }

  if (diagRoiResults.length > 0) {
    const r = diagRoiResults[0];
    toonLines.push("", "# Diagnostics G3 (Unified JXTC Tiled ROI vs Monolithic ROI ms)");
    toonLines.push(`  RoiFileUnderBenchmark: ${r.file}`);
    toonLines.push(`  MonolithicRoi_512_512_Ms: ${r.monolithicMs}`);
    toonLines.push(`  RealJxtcTiledRoi_512_512_Ms: ${r.jxtcMs}`);
    toonLines.push(`  JxtcTiledSequential_4_256_256_Ms: ${r.tiledSeqMs}`);
    toonLines.push(`  JxtcTiledParallel_4_256_256_Ms: ${r.tiledParMs}`);
  }

  toonLines.push("", "# Averages");
  toonLines.push(`AvgRawMs: ${avgRaw}`);
  toonLines.push(`AvgScaleMs: ${avgScale}`);
  toonLines.push(`AvgRawDecompressMs: ${avgRawDecomp} | AvgRawDemosaicMs: ${avgRawDemo} | AvgRawTonemapMs: ${avgRawTone}`);
  toonLines.push(`AvgProgEncSimdMs: ${avgProgEncSimd} | AvgProgEncMtMs: ${avgProgEncMt}`);
  toonLines.push(`AvgProgFirstSimdMs: ${avgProgFirstSimd} | AvgProgFirstMtMs: ${avgProgFirstMt}`);
  toonLines.push(`AvgProgFinalSimdMs: ${avgProgFinalSimd} | AvgProgFinalMtMs: ${avgProgFinalMt}`);
  toonLines.push(`AvgShotEncSimdMs: ${avgShotEncSimd} | AvgShotEncMtMs: ${avgShotEncMt}`);
  toonLines.push(`AvgShotDecSimdMs: ${avgShotDecSimd} | AvgShotDecMtMs: ${avgShotDecMt}`);
  toonLines.push(`AvgPyrEncSimdMs: ${avgPyrEncSimd} | AvgPyrEncMtMs: ${avgPyrEncMt}`);
  toonLines.push(`AvgPyrDecSimdMs: ${avgPyrDecSimd} | AvgPyrDecMtMs: ${avgPyrDecMt}`);
  toonLines.push(`AvgProgDs2FirstSimdMs: ${avgProgDs2First} | AvgProgChunked4FirstSimdMs: ${avgProgChunkedFirst}`);
  toonLines.push(`AvgModProgEncSimdMs: ${avgModProgEnc}`);
  toonLines.push(`AvgPhotonProgEncSimdMs: ${avgPhotonProgEnc}`);

  let toonString = toonLines.join("\n");

  console.log(`=========================================`);
  console.log(`📊 TOON RESULTS (Sequential, Parallel, Multi-Thread & Deep Diagnostics)`);
  console.log(`=========================================`);
  console.log(toonString);
  console.log(`=========================================\n`);

  // Write TOON file to output directory
  const OUT_DIR = String.raw`C:\Foo\raw-converter-wasm\docs\outputs\timing tests`;
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  const stamp = runTimestamp.replace(/[:.]/g, "-");
  const fileName = `${stamp}-StandardMultifileTest-${batchName}.toon`;
  const outPath = join(OUT_DIR, fileName);

  // Append granular FFI encode timings dynamically before writing!
  const finalEnc = globalThis.finalEncMetrics || {};
  let ffiBlock = "\n# Granular Encoding FFI Sub-timers (ms)\n";
  ffiBlock += `EncInputPrepMs: ${finalEnc.enc_input_prep !== undefined ? finalEnc.enc_input_prep.toFixed(2) : 'N/A'}\n`;
  ffiBlock += `EncHeapMallocMs: ${finalEnc.enc_malloc !== undefined ? finalEnc.enc_malloc.toFixed(2) : 'N/A'}\n`;
  ffiBlock += `EncHeapCopyMs: ${finalEnc.enc_heap_set !== undefined ? finalEnc.enc_heap_set.toFixed(2) : 'N/A'}\n`;
  ffiBlock += `EncCoreCompressMs: ${finalEnc.enc_wasm_encode !== undefined ? finalEnc.enc_wasm_encode.toFixed(2) : 'N/A'}\n`;
  ffiBlock += `EncBufferReadMs: ${finalEnc.enc_buffer_read !== undefined ? finalEnc.enc_buffer_read.toFixed(2) : 'N/A'}\n`;
  ffiBlock += `EncHeapFreeMs: ${finalEnc.enc_free !== undefined ? finalEnc.enc_free.toFixed(2) : 'N/A'}\n\n`;
  
  toonString = toonString.replace("---", ffiBlock + "---");

  writeFileSync(outPath, toonString);
  console.log(`✅ TOON file successfully written to: ${outPath}\n`);

  const consolidation = consolidateBenchmarkHistory({
    timingDir: OUT_DIR,
    legacyRoots: [
      String.raw`C:\Foo\raw-converter-wasm\docs\Benchmark results`,
      join(OUT_DIR, "backup"),
    ],
    backupDirName: "backup",
  });
  const historicalRuns = consolidation.toonFiles
    .filter((name) => name.endsWith(".toon"))
    .filter((name) => !name.endsWith("GraphAggregateResults.toon"));
  const graphModel = buildGraphHistory(historicalRuns);
  const launchStatePath = join(OUT_DIR, ".graph-browser-launch-state.json");
  const launchSelection = getNextGraphBrowserLaunchMethod({
    statePath: launchStatePath,
    overrideMethodId: process.env.STANDARD_MULTIFILE_OPEN_GRAPH_METHOD || null,
  });
  const launchBadge = `${launchSelection.method.label} - ${launchSelection.method.description}`;
  const graphHtml = buildGraphAggregateHtml(graphModel, { launchBadge });
  const graphPath = join(OUT_DIR, "GraphAggregateResults.html");
  writeFileSync(graphPath, graphHtml);
  console.log(`✅ Graph aggregate HTML successfully written to: ${graphPath}\n`);
  console.log(`Graph launch method: ${launchBadge}`);

  if (process.env.STANDARD_MULTIFILE_OPEN_GRAPH !== "0") {
    try {
      if (process.platform === "win32") {
        const browser = chooseGraphBrowser({
          chromePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          edgePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          bravePath: "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
        });
        const launchMethodId = launchSelection.method.id === "direct-spawn" && !browser.path
          ? "explorer"
          : launchSelection.method.id;
        const plan = buildGraphBrowserLaunchPlan({
          methodId: launchMethodId,
          browserPath: browser.path,
          filePath: graphPath,
        });
        if (plan.browserPath) {
          const child = spawn(plan.browserPath, plan.args, plan.options);
          child.unref();
        }
      } else if (process.platform === "darwin") {
        execSync(`open "${graphPath.replace(/"/g, '\\"')}"`, { stdio: "ignore" });
      } else {
        execSync(`xdg-open "${graphPath.replace(/"/g, '\\"')}"`, { stdio: "ignore" });
      }
      console.log(`✅ Graph aggregate HTML opened in browser.\n`);
    } catch (err) {
      console.log(`⚠️  Graph aggregate HTML could not be opened automatically.\n`);
    }
  }
}

main().then(() => process.exit(0)).catch(err => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
