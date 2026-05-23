// jxl-worker-browser/src/worker.ts
// DedicatedWorker host for WASM codec sessions.
// Spec: Section 26 T-WORKER-BROWSER brief, Sections 10/11/16.
//
// This file is the worker entry point. It owns the WASM module lifecycle and
// routes messages by sessionId to decode or encode handlers.
// The WASM codec (jxl-wasm) is imported dynamically via wasmUrl; stubs are
// used until T-WASM-BUILD lands and provides real artifacts.

/// <reference lib="webworker" />

import type {
  MainToWorkerMessage,
  MsgDecodeStart,
  MsgEncodeStart,
  MsgDecodeChunk,
  MsgDecodeClose,
  MsgDecodeCancel,
  MsgEncodePixels,
  MsgEncodeFinish,
  MsgEncodeCancel,
  MsgWorkerReady,
  MsgWorkerShutdownAck,
} from "@casabio/jxl-core/protocol";

import { DecodeHandler } from "./decode-handler.js";
import { EncodeHandler } from "./encode-handler.js";
import { loadWasmModule, type JxlModule } from "./wasm-loader.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const decodeSessions = new Map<string, DecodeHandler>();
const encodeSessions = new Map<string, EncodeHandler>();
let wasmModule: JxlModule | null = null;
let wasmLoadPromise: Promise<JxlModule> | null = null;
let shuttingDown = false;

// ---------------------------------------------------------------------------
// WASM acquisition (lazy, singleton)
// ---------------------------------------------------------------------------

async function getWasm(): Promise<JxlModule> {
  if (wasmModule !== null) return wasmModule;
  if (wasmLoadPromise === null) {
    // wasmUrl may be overridden by an init message before the first session.
    wasmLoadPromise = loadWasmModule(resolvedWasmUrl()).then((m) => {
      wasmModule = m;
      return m;
    });
  }
  return wasmLoadPromise;
}

// wasmUrl is injected by the caller via a query param or an init message.
// Default path assumes the worker script and WASM live in the same directory.
let _wasmUrl: string | null = null;

function resolvedWasmUrl(): string {
  if (_wasmUrl !== null) return _wasmUrl;
  // Fall back to same-origin relative path; callers may override via
  // MsgWorkerInit (not a spec message — handled below as a local extension).
  return new URL("./jxl-core.wasm", self.location.href).href;
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

self.onmessage = (ev: MessageEvent<MainToWorkerMessage>) => {
  const msg = ev.data;

  if (shuttingDown && msg.type !== "worker_shutdown") {
    // Drain: reject new sessions during shutdown.
    return;
  }

  switch (msg.type) {
    case "decode_start":
      handleDecodeStart(msg);
      break;

    case "decode_chunk": {
      const { sessionId, chunk } = msg as MsgDecodeChunk;
      decodeSessions.get(sessionId)?.onChunk(chunk);
      break;
    }

    case "decode_close": {
      const { sessionId } = msg;
      decodeSessions.get(sessionId)?.onClose();
      break;
    }

    case "decode_cancel": {
      const m = msg as MsgDecodeCancel;
      decodeSessions.get(m.sessionId)?.onCancel(m.reason);
      break;
    }

    case "decode_pause": {
      decodeSessions.get(msg.sessionId)?.onPause();
      break;
    }

    case "decode_resume": {
      decodeSessions.get(msg.sessionId)?.onResume();
      break;
    }

    case "encode_start":
      handleEncodeStart(msg);
      break;

    case "encode_pixels": {
      const m = msg as MsgEncodePixels;
      encodeSessions.get(m.sessionId)?.onPixels(m.chunk, m.region);
      break;
    }

    case "encode_finish": {
      const { sessionId } = msg;
      encodeSessions.get(sessionId)?.onFinish();
      break;
    }

    case "encode_cancel": {
      const m = msg as MsgEncodeCancel;
      encodeSessions.get(m.sessionId)?.onCancel(m.reason);
      break;
    }

    case "worker_shutdown":
      handleShutdown();
      break;

    case "release_state": {
      // Clean up any stale session state from a re-submitted task.
      const { sessionId } = msg;
      decodeSessions.delete(sessionId);
      encodeSessions.delete(sessionId);
      break;
    }

    default:
      // Unknown message — ignore; forward-compatibility.
      break;
  }
};

// ---------------------------------------------------------------------------
// Decode session start
// ---------------------------------------------------------------------------

async function handleDecodeStart(msg: MsgDecodeStart): Promise<void> {
  let wasm: JxlModule;
  try {
    wasm = await getWasm();
  } catch (err) {
    self.postMessage({
      type: "decode_error",
      sessionId: msg.sessionId,
      code: "CapabilityMissing",
      message: `WASM module failed to load: ${String(err)}`,
    });
    return;
  }

  const handler = new DecodeHandler(msg, wasm, {
    onSessionEnd: (sessionId) => decodeSessions.delete(sessionId),
  });
  decodeSessions.set(msg.sessionId, handler);
}

// ---------------------------------------------------------------------------
// Encode session start
// ---------------------------------------------------------------------------

async function handleEncodeStart(msg: MsgEncodeStart): Promise<void> {
  let wasm: JxlModule;
  try {
    wasm = await getWasm();
  } catch (err) {
    self.postMessage({
      type: "encode_error",
      sessionId: msg.sessionId,
      code: "CapabilityMissing",
      message: `WASM module failed to load: ${String(err)}`,
    });
    return;
  }

  const handler = new EncodeHandler(msg, wasm, {
    onSessionEnd: (sessionId) => encodeSessions.delete(sessionId),
  });
  encodeSessions.set(msg.sessionId, handler);
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function handleShutdown(): Promise<void> {
  shuttingDown = true;

  // Cancel all active sessions.
  const cancelPromises: Promise<void>[] = [];

  for (const [, handler] of decodeSessions) {
    cancelPromises.push(handler.onCancel("worker_shutdown").catch(() => undefined));
  }
  for (const [, handler] of encodeSessions) {
    cancelPromises.push(handler.onCancel("worker_shutdown").catch(() => undefined));
  }

  await Promise.allSettled(cancelPromises);

  decodeSessions.clear();
  encodeSessions.clear();
  wasmModule = null;
  wasmLoadPromise = null;

  const ack: MsgWorkerShutdownAck = { type: "worker_shutdown_ack" };
  self.postMessage(ack);
  self.close();
}

// ---------------------------------------------------------------------------
// Startup announcement
// ---------------------------------------------------------------------------

// Post worker_ready once the script has loaded. WASM is loaded lazily on
// first session to avoid blocking worker startup.
const ready: MsgWorkerReady = { type: "worker_ready", backend: "wasm" };
self.postMessage(ready);
