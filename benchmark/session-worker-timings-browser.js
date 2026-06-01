import initRaw, {
  process_cr2_with_flags,
  process_dng_with_flags,
  process_orf_with_flags,
  rgb_to_rgba,
} from "../pkg/raw_converter_wasm.js";
import { createBrowserContext } from "@casabio/jxl-session";

const OUTPUT_FULL_RGB = 1;
const PROCESS_ARGS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Number.NaN, Number.NaN, 0, 0];

function takeRgbaForMode(result, mode = "take") {
  const normalized = String(mode || "take").toLowerCase();
  const rawRgbBytes = result.width * result.height * 3;
  const rgbaBytes = result.width * result.height * 4;
  if (normalized === "js") {
    return {
      rgba: rgb_to_rgba(result.take_rgb()),
      rgbaPrepMode: "js-rgb-to-rgba",
      rawRgbBytes,
      rgbaBytes,
    };
  }
  if (normalized === "take" || normalized === "a") {
    if (typeof result.take_rgba !== "function") {
      return {
        rgba: rgb_to_rgba(result.take_rgb()),
        rgbaPrepMode: "js-rgb-to-rgba",
        rawRgbBytes,
        rgbaBytes,
      };
    }
    return {
      rgba: result.take_rgba(),
      rgbaPrepMode: "wasm-take-rgba",
      rawRgbBytes,
      rgbaBytes,
    };
  }
  if (normalized === "direct" || normalized === "b") {
    if (typeof result.take_rgba_direct !== "function") {
      throw new Error("RAW_RGBA_MODE=direct requested, but this wasm build does not export take_rgba_direct");
    }
    return {
      rgba: result.take_rgba_direct(),
      rgbaPrepMode: "wasm-direct-rgba",
      rawRgbBytes,
      rgbaBytes,
    };
  }
  throw new Error(`Unsupported RAW_RGBA_MODE=${normalized}; expected js, take, or direct`);
}
const ENCODE_OPTIONS = {
  quality: 90,
  effort: 3,
  progressive: false,
  previewFirst: false,
  chunked: false,
  lossless: false,
};

let rawReady = null;

function fmtMs(value) {
  return `${value.toFixed(1)} ms`;
}

function status(message) {
  const target = document.getElementById("status");
  if (target) target.textContent = message;
}

function exactBuffer(view) {
  if (view instanceof ArrayBuffer) return view;
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view.buffer;
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

function resizeRgbaCanvas(rgba, width, height, maxEdge) {
  if (!Number.isFinite(maxEdge) || maxEdge <= 0 || Math.max(width, height) <= maxEdge) {
    return { rgba, width, height };
  }
  const scale = maxEdge / Math.max(width, height);
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));

  const sourceCanvas = new OffscreenCanvas(width, height);
  const sourceCtx = sourceCanvas.getContext("2d");
  sourceCtx.putImageData(
    new ImageData(new Uint8ClampedArray(exactBuffer(rgba)), width, height),
    0,
    0,
  );

  const targetCanvas = new OffscreenCanvas(targetWidth, targetHeight);
  const targetCtx = targetCanvas.getContext("2d", { willReadFrequently: true });
  targetCtx.drawImage(sourceCanvas, 0, 0, targetWidth, targetHeight);
  return {
    rgba: new Uint8Array(targetCtx.getImageData(0, 0, targetWidth, targetHeight).data.buffer),
    width: targetWidth,
    height: targetHeight,
  };
}

function concatChunks(chunks) {
  if (chunks.length === 1) {
    const only = chunks[0];
    return only instanceof Uint8Array ? only : new Uint8Array(only);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    const view = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    bytes.set(view, offset);
    offset += view.byteLength;
  }
  return bytes;
}

function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function initRawOnce() {
  if (rawReady === null) {
    rawReady = initRaw({
      module_or_path: new URL("../pkg/raw_converter_wasm_bg.wasm", import.meta.url),
    });
  }
  await rawReady;
}

function processRaw(type, bytes) {
  switch (type) {
    case "orf":
      return process_orf_with_flags(bytes, OUTPUT_FULL_RGB, ...PROCESS_ARGS);
    case "dng":
      return process_dng_with_flags(bytes, OUTPUT_FULL_RGB, ...PROCESS_ARGS);
    case "cr2":
      return process_cr2_with_flags(bytes, OUTPUT_FULL_RGB, ...PROCESS_ARGS);
    default:
      throw new Error(`Unsupported type: ${type}`);
  }
}

function makeEncoderOptions(source) {
  return {
    format: "rgba8",
    width: source.width,
    height: source.height,
    hasAlpha: true,
    iccProfile: new Uint8Array(0),
    distance: ENCODE_OPTIONS.lossless ? 0 : null,
    quality: ENCODE_OPTIONS.lossless ? null : ENCODE_OPTIONS.quality,
    effort: ENCODE_OPTIONS.effort,
    progressive: ENCODE_OPTIONS.progressive,
    previewFirst: ENCODE_OPTIONS.previewFirst,
    chunked: ENCODE_OPTIONS.chunked,
  };
}

function makeDecoderOptions() {
  return {
    format: "rgba8",
    region: null,
    downsample: 1,
    progressionTarget: "final",
    emitEveryPass: false,
    preserveIcc: true,
    preserveMetadata: true,
  };
}

async function encodeWithSession(context, source, timeouts) {
  const started = performance.now();
  const metrics = {};
  const session = context.encode({
    ...makeEncoderOptions(source),
    onMetric: (m) => {
      if (m && m.name) metrics[m.name] = m.value;
    },
  });
  const chunks = [];
  let firstChunkMs = null;
  const chunkTask = (async () => {
    for await (const chunk of session.chunks()) {
      if (firstChunkMs === null) firstChunkMs = performance.now() - started;
      console.log(`[session-stage] encode chunk ${chunk.byteLength}`);
      chunks.push(chunk);
    }
    console.log("[session-stage] encode chunks iterator done");
  })();

  try {
    console.log(`[session-stage] encode push ${source.width}x${source.height}`);
    await withTimeout(
      session.pushPixels(exactBuffer(source.rgba)),
      timeouts.stageMs,
      "session encode pushPixels",
    );
    console.log("[session-stage] encode push accepted");
    await withTimeout(session.finish(), timeouts.stageMs, "session encode finish");
    console.log("[session-stage] encode finish accepted; waiting done/chunks");
    const doneTask = session.done().then((doneBytes) => {
      console.log(`[session-stage] encode done ${doneBytes}`);
      return doneBytes;
    });
    const [totalBytes] = await withTimeout(
      Promise.all([doneTask, chunkTask]).then(([doneBytes]) => [doneBytes]),
      timeouts.completionMs,
      "session encode completion",
    );
    if (chunks.length === 0) {
      throw new Error(`session encode finished with ${totalBytes} bytes but yielded no chunks`);
    }
    return {
      bytes: concatChunks(chunks),
      encodeMs: performance.now() - started,
      firstChunkMs,
      metrics,
    };
  } catch (error) {
    await session.cancel?.(`session-worker-timings encode failed: ${error?.message || error}`).catch(() => {});
    throw error;
  }
}

async function decodeWithSession(context, bytes, timeouts) {
  const metrics = {};
  const session = context.decode({
    ...makeDecoderOptions(),
    onMetric: (m) => {
      if (m && m.name) metrics[m.name] = m.value;
    },
  });
  try {
    await withTimeout(session.push(exactBuffer(bytes)), timeouts.stageMs, "session decode push");
    await withTimeout(session.close(), timeouts.stageMs, "session decode close");
    let final = null;
    const doneTask = withTimeout(session.done(), timeouts.completionMs, "session decode completion");
    for await (const event of session.frames()) {
      if (event.stage === "final") final = event;
    }
    await doneTask;
    if (!final) throw new Error("session decode produced no final frame");
    return { final, metrics };
  } catch (error) {
    await session.cancel?.(`session-worker-timings decode failed: ${error?.message || error}`).catch(() => {});
    throw error;
  }
}

async function runSessionPipeline(context, source, timeouts) {
  const encoded = await encodeWithSession(context, source, timeouts);
  const jxlBytes = encoded.bytes.byteLength;
  const decodeStarted = performance.now();
  const decoded = await decodeWithSession(context, encoded.bytes, timeouts);
  return {
    encodeMs: encoded.encodeMs,
    firstChunkMs: encoded.firstChunkMs ?? encoded.encodeMs,
    decodeMs: performance.now() - decodeStarted,
    jxlBytes,
    finalWidth: decoded.final.info.width,
    finalHeight: decoded.final.info.height,
    // Rich metrics from both sides (for artifact analysis)
    encodeMetrics: encoded.metrics ?? {},
    decodeMetrics: decoded.metrics ?? {},
    // Common useful shortcuts
    schedulerQueueWaitMs: decoded.metrics?.scheduler_queue_wait_ms ?? 0,
    timeToFirstPixelMs: decoded.metrics?.time_to_first_pixel_ms ?? null,
    timeToHeaderMs: decoded.metrics?.time_to_header_ms ?? null,
  };
}

async function measureOne(context, entry, config) {
  if (config.traceProgress) console.log(`[session] fetch ${entry.file}`);
  const response = await fetch(entry.url);
  if (!response.ok) throw new Error(`Failed to fetch ${entry.file}: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());

  const rawStarted = performance.now();
  const result = processRaw(entry.type, bytes);
  const rawWallMs = performance.now() - rawStarted;

  try {
    const rgbaStarted = performance.now();
    const {
      rgba,
      rgbaPrepMode,
      rawRgbBytes,
      rgbaBytes,
    } = takeRgbaForMode(result, config.rawRgbaMode);
    const rgbaPrepMs = performance.now() - rgbaStarted;
    const resized = resizeRgbaCanvas(rgba, result.width, result.height, config.maxEdge);

    const session = await runSessionPipeline(
      context,
      resized,
      config.timeouts,
    );

    if (config.traceStages) {
      console.log(
        `[session] ${entry.file} rawWall ${fmtMs(rawWallMs)} prep ${fmtMs(rgbaPrepMs)} ${rgbaPrepMode} rgb ${fmtMb(rawRgbBytes)} rgba ${fmtMb(rgbaBytes)} enc ${fmtMs(session.encodeMs)} dec ${fmtMs(session.decodeMs)}`,
      );
    }

    return {
      file: entry.file,
      path: entry.path,
      type: entry.type,
      sizeBytes: bytes.byteLength,
      width: result.width,
      height: result.height,
      workWidth: resized.width,
      workHeight: resized.height,
      decompressMs: result.decompress_ms ?? 0,
      demosaicMs: result.demosaic_ms ?? 0,
      tonemapMs: result.tonemap_ms ?? 0,
      orientMs: result.orient_ms ?? 0,
      rawWallMs,
      rgbaPrepMs,
      rgbaPrepMode,
      rawRgbBytes,
      rgbaBytes,
      encodeMs: session.encodeMs,
      firstChunkMs: session.firstChunkMs,
      decodeMs: session.decodeMs,
      jxlBytes: session.jxlBytes,
      // Full session metrics (now captured on both encode and decode)
      encodeMetrics: session.encodeMetrics ?? {},
      decodeMetrics: session.decodeMetrics ?? {},
      schedulerQueueWaitMs: session.schedulerQueueWaitMs ?? 0,
      timeToFirstPixelMs: session.timeToFirstPixelMs ?? null,
      timeToHeaderMs: session.timeToHeaderMs ?? null,
    };
  } finally {
    result.free();
  }
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function collapseRuns(runs) {
  const pick = (key) => median(runs.map((run) => run[key]));
  const first = runs[0];
  return {
    ...first,
    runs: runs.length,
    decompressMs: pick("decompressMs"),
    demosaicMs: pick("demosaicMs"),
    tonemapMs: pick("tonemapMs"),
    orientMs: pick("orientMs"),
    rawWallMs: pick("rawWallMs"),
    rgbaPrepMs: pick("rgbaPrepMs"),
    rgbaPrepMode: first.rgbaPrepMode ?? "unknown",
    rawRgbBytes: first.rawRgbBytes ?? 0,
    rgbaBytes: first.rgbaBytes ?? 0,
    encodeMs: pick("encodeMs"),
    firstChunkMs: pick("firstChunkMs"),
    decodeMs: pick("decodeMs"),
    jxlBytes: Math.round(median(runs.map((run) => run.jxlBytes))),
    // Keep the metric objects from the first run (they are diagnostic, not aggregated)
    encodeMetrics: first.encodeMetrics ?? {},
    decodeMetrics: first.decodeMetrics ?? {},
    schedulerQueueWaitMs: pick("schedulerQueueWaitMs"),
    timeToFirstPixelMs: pick("timeToFirstPixelMs"),
    timeToHeaderMs: pick("timeToHeaderMs"),
  };
}

function derived(row) {
  const rawMs = row.rawWallMs;
  const totalMs = rawMs + row.rgbaPrepMs + row.encodeMs + row.decodeMs;
  return { rawMs, totalMs };
}

function rankWorst(rows) {
  return [...rows].sort((a, b) => derived(b).totalMs - derived(a).totalMs);
}

async function runMeasured(context, entries, runsPerFile, config, label) {
  const out = [];
  for (const [index, entry] of entries.entries()) {
    const runs = [];
    for (let run = 0; run < runsPerFile; run += 1) {
      if (config.traceProgress) {
        console.log(`[session] ${label} ${index + 1}/${entries.length} run ${run + 1}/${runsPerFile} ${entry.file}`);
      }
      status(`${label} ${index + 1}/${entries.length} ${entry.file}`);
      runs.push(await measureOne(context, entry, config));
    }
    out.push(collapseRuns(runs));
  }
  return out;
}

window.runSessionWorkerTimings = async function runSessionWorkerTimings(config) {
  await initRawOnce();
  const context = createBrowserContext({
    poolSize: 1,
    idleTimeoutMs: 120000,
    wasmUrl: new URL("./session-worker-forced-worker.js", import.meta.url).href,
  });
  try {
    const testRows = rankWorst(await runMeasured(context, config.testEntries, config.testRuns, config, "tests"));
    const gobScanRows = rankWorst(await runMeasured(context, config.gobEntries, 1, config, "gob-scan"));
    const offenderIds = new Set(gobScanRows.slice(0, config.gobOffenderCount).map((row) => row.path));
    const offenderEntries = config.gobEntries.filter((entry) => offenderIds.has(entry.path));
    const gobOffenders = rankWorst(
      await runMeasured(context, offenderEntries, config.gobOffenderRuns, config, "gob-offenders"),
    );
    status("session-worker-timings complete");
    return { testRows, gobScanRows, gobOffenders };
  } finally {
    await context.shutdown();
  }
};
