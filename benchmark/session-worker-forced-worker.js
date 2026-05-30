import {
  createDecoder,
  createEncoder,
  detectTier,
  setForcedTier,
} from "../packages/jxl-wasm/dist/index.js";

setForcedTier("simd");

const encodeSessions = new Map();
const decodeSessions = new Map();

function exactBuffer(view) {
  if (view instanceof ArrayBuffer) return view;
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view.buffer;
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

function concatBuffers(chunks) {
  if (chunks.length === 1) return exactBuffer(chunks[0]);
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

function postError(kind, sessionId, error) {
  self.postMessage({
    type: `${kind}_error`,
    sessionId,
    code: "Internal",
    message: error instanceof Error ? error.message : String(error),
  });
}

function encoderOptions(msg) {
  return {
    format: msg.format,
    width: msg.width,
    height: msg.height,
    hasAlpha: msg.hasAlpha,
    iccProfile: msg.iccProfile,
    exif: msg.exif,
    xmp: msg.xmp,
    distance: msg.distance,
    quality: msg.quality,
    effort: msg.effort,
    progressive: msg.progressive,
    previewFirst: msg.previewFirst,
    chunked: msg.chunked,
    sidecarSizes: msg.sidecarSizes,
  };
}

function decoderOptions(msg) {
  return {
    format: msg.format,
    region: msg.region,
    downsample: msg.downsample,
    progressionTarget: msg.progressionTarget,
    emitEveryPass: msg.emitEveryPass,
    preserveIcc: msg.preserveIcc,
    preserveMetadata: msg.preserveMetadata,
    targetWidth: msg.targetWidth,
    targetHeight: msg.targetHeight,
    fitMode: msg.fitMode,
  };
}

async function runEncode(sessionId) {
  const state = encodeSessions.get(sessionId);
  if (!state) return;
  console.log(`[session-worker] encode start ${state.start.width}x${state.start.height}`);
  const encoder = createEncoder(encoderOptions(state.start));
  let totalBytes = 0;
  let firstByteSent = false;

  try {
    const chunkTask = (async () => {
      for await (const chunk of encoder.chunks()) {
        const buffer = exactBuffer(chunk);
        if (!firstByteSent) {
          firstByteSent = true;
          self.postMessage({ type: "encode_first_byte_ready", sessionId });
        }
        totalBytes += buffer.byteLength;
        self.postMessage({ type: "encode_chunk", sessionId, chunk: buffer }, [buffer]);
      }
    })();

    for (const entry of state.pixels) {
      console.log(`[session-worker] push pixels ${entry.chunk.byteLength}`);
      await encoder.pushPixels(entry.chunk, entry.region);
      console.log("[session-worker] push pixels done");
      self.postMessage({
        type: "worker_drain",
        sessionId,
        latencyMs: 0,
        queueDepth: 0,
        queuedBytes: 0,
        adaptiveHwm: 4,
      });
    }
    console.log("[session-worker] finish");
    await encoder.finish();
    console.log("[session-worker] finish done; waiting chunks");
    await chunkTask;
    console.log(`[session-worker] chunks done ${totalBytes}`);
    self.postMessage({ type: "encode_done", sessionId, totalBytes });
  } catch (error) {
    postError("encode", sessionId, error);
  } finally {
    encodeSessions.delete(sessionId);
    await Promise.resolve(encoder.dispose()).catch(() => {});
  }
}

async function runDecode(sessionId) {
  const state = decodeSessions.get(sessionId);
  if (!state) return;
  const decoder = createDecoder(decoderOptions(state.start));

  try {
    await decoder.push(concatBuffers(state.chunks));
    await decoder.close();
    for await (const event of decoder.events()) {
      if (event.type === "header") {
        self.postMessage({ type: "decode_header", sessionId, info: event.info });
      } else if (event.type === "progress") {
        const pixels = exactBuffer(event.pixels);
        self.postMessage({
          type: "decode_progress",
          sessionId,
          stage: event.stage,
          info: event.info,
          pixels,
          format: event.format,
          pixelStride: event.pixelStride,
          ...(event.region !== undefined ? { region: event.region } : {}),
        }, [pixels]);
      } else if (event.type === "final") {
        const pixels = exactBuffer(event.pixels);
        self.postMessage({
          type: "decode_final",
          sessionId,
          info: event.info,
          pixels,
          format: event.format,
          pixelStride: event.pixelStride,
          ...(event.region !== undefined ? { region: event.region } : {}),
        }, [pixels]);
      } else if (event.type === "budget_exceeded") {
        const pixels = exactBuffer(event.pixels);
        self.postMessage({
          type: "decode_budget_exceeded",
          sessionId,
          stage: event.stage,
          info: event.info,
          pixels,
          format: event.format,
          pixelStride: event.pixelStride,
          ...(event.region !== undefined ? { region: event.region } : {}),
        }, [pixels]);
      }
    }
  } catch (error) {
    postError("decode", sessionId, error);
  } finally {
    decodeSessions.delete(sessionId);
    await Promise.resolve(decoder.dispose()).catch(() => {});
  }
}

self.onmessage = (event) => {
  const msg = event.data;
  switch (msg.type) {
    case "encode_start":
      encodeSessions.set(msg.sessionId, { start: msg, pixels: [] });
      break;
    case "encode_pixels":
      encodeSessions.get(msg.sessionId)?.pixels.push({ chunk: msg.chunk, region: msg.region });
      break;
    case "encode_finish":
      void runEncode(msg.sessionId);
      break;
    case "encode_cancel":
      encodeSessions.delete(msg.sessionId);
      self.postMessage({ type: "encode_cancelled", sessionId: msg.sessionId });
      break;
    case "decode_start":
      decodeSessions.set(msg.sessionId, { start: msg, chunks: [] });
      break;
    case "decode_chunk":
      decodeSessions.get(msg.sessionId)?.chunks.push(msg.chunk);
      self.postMessage({
        type: "worker_drain",
        sessionId: msg.sessionId,
        latencyMs: 0,
        queueDepth: 0,
        queuedBytes: 0,
        adaptiveHwm: 4,
      });
      break;
    case "decode_close":
      void runDecode(msg.sessionId);
      break;
    case "decode_cancel":
      decodeSessions.delete(msg.sessionId);
      self.postMessage({ type: "decode_cancelled", sessionId: msg.sessionId });
      break;
    case "worker_shutdown":
      self.postMessage({ type: "worker_shutdown_ack" });
      break;
    case "release_state":
      encodeSessions.delete(msg.sessionId);
      decodeSessions.delete(msg.sessionId);
      break;
    default:
      break;
  }
};

self.postMessage({ type: "worker_ready", backend: "wasm", wasmBuild: detectTier() });
