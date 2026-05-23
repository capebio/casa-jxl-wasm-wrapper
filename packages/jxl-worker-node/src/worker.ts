// jxl-worker-node/src/worker.ts
// node:worker_threads host for JXL codec sessions.
// Spec: Section 26 T-WORKER-NODE brief, Sections 15, 16.
//
// Startup: attempt require('jxl-native'). On success, route to native handlers.
// On failure or JXL_FORCE_WASM=1, fall back to WASM via jxl-wasm.
// Reports backend choice in worker_ready message.

import { parentPort, isMainThread, workerData } from "node:worker_threads";
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
import { selectBackend, type Backend } from "./backend-selector.js";

if (isMainThread) {
  throw new Error("[jxl-worker-node] This file must be run as a worker_threads worker.");
}
if (parentPort === null) {
  throw new Error("[jxl-worker-node] parentPort is null — not a worker thread.");
}

const port = parentPort;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const decodeSessions = new Map<string, DecodeHandler>();
const encodeSessions = new Map<string, EncodeHandler>();
let shuttingDown = false;
let backend: Backend | null = null;

// ---------------------------------------------------------------------------
// Backend selection (native vs WASM)
// ---------------------------------------------------------------------------

async function initBackend(): Promise<Backend> {
  if (backend !== null) return backend;
  backend = await selectBackend();
  return backend;
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

port.on("message", (msg: MainToWorkerMessage) => {
  if (shuttingDown && msg.type !== "worker_shutdown") return;

  switch (msg.type) {
    case "decode_start":
      void handleDecodeStart(msg);
      break;

    case "decode_chunk": {
      const m = msg as MsgDecodeChunk;
      decodeSessions.get(m.sessionId)?.onChunk(m.chunk);
      break;
    }

    case "decode_close":
      decodeSessions.get(msg.sessionId)?.onClose();
      break;

    case "decode_cancel": {
      const m = msg as MsgDecodeCancel;
      void decodeSessions.get(m.sessionId)?.onCancel(m.reason);
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
      void handleEncodeStart(msg);
      break;

    case "encode_pixels": {
      const m = msg as MsgEncodePixels;
      encodeSessions.get(m.sessionId)?.onPixels(m.chunk, m.region);
      break;
    }

    case "encode_finish":
      encodeSessions.get(msg.sessionId)?.onFinish();
      break;

    case "encode_cancel": {
      const m = msg as MsgEncodeCancel;
      void encodeSessions.get(m.sessionId)?.onCancel(m.reason);
      break;
    }

    case "worker_shutdown":
      void handleShutdown();
      break;

    case "release_state":
      decodeSessions.delete(msg.sessionId);
      encodeSessions.delete(msg.sessionId);
      break;

    default:
      break;
  }
});

// ---------------------------------------------------------------------------
// Decode session start
// ---------------------------------------------------------------------------

async function handleDecodeStart(msg: MsgDecodeStart): Promise<void> {
  let b: Backend;
  try {
    b = await initBackend();
  } catch (err) {
    port.postMessage({
      type: "decode_error",
      sessionId: msg.sessionId,
      code: "CapabilityMissing",
      message: `Backend init failed: ${String(err)}`,
    });
    return;
  }

  const handler = new DecodeHandler(msg, b, {
    onSessionEnd: (id) => decodeSessions.delete(id),
    port,
  });
  decodeSessions.set(msg.sessionId, handler);
}

// ---------------------------------------------------------------------------
// Encode session start
// ---------------------------------------------------------------------------

async function handleEncodeStart(msg: MsgEncodeStart): Promise<void> {
  let b: Backend;
  try {
    b = await initBackend();
  } catch (err) {
    port.postMessage({
      type: "encode_error",
      sessionId: msg.sessionId,
      code: "CapabilityMissing",
      message: `Backend init failed: ${String(err)}`,
    });
    return;
  }

  const handler = new EncodeHandler(msg, b, {
    onSessionEnd: (id) => encodeSessions.delete(id),
    port,
  });
  encodeSessions.set(msg.sessionId, handler);
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function handleShutdown(): Promise<void> {
  shuttingDown = true;

  const cancelPromises: Promise<void>[] = [];
  for (const [, h] of decodeSessions) cancelPromises.push(h.onCancel("worker_shutdown").catch(() => undefined));
  for (const [, h] of encodeSessions) cancelPromises.push(h.onCancel("worker_shutdown").catch(() => undefined));

  await Promise.allSettled(cancelPromises);

  decodeSessions.clear();
  encodeSessions.clear();

  const ack: MsgWorkerShutdownAck = { type: "worker_shutdown_ack" };
  port.postMessage(ack);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Startup: select backend and post worker_ready
// ---------------------------------------------------------------------------

void (async () => {
  const b = await selectBackend().catch(() => null);
  const ready: MsgWorkerReady = {
    type: "worker_ready",
    backend: b?.type ?? "wasm",
  };
  port.postMessage(ready);
  // Stash backend for subsequent sessions.
  backend = b;
})();
