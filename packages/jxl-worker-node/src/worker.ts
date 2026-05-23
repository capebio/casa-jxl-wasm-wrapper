// jxl-worker-node/src/worker.ts
// node:worker_threads host for JXL codec sessions.
// Spec: Section 26 T-WORKER-NODE brief, Sections 15, 16.
//
// Startup: attempt require('jxl-native'). On success, route to native handlers.
// On failure or JXL_FORCE_WASM=1, fall back to WASM via jxl-wasm.
// Reports backend choice in worker_ready message.

import { parentPort, isMainThread } from "node:worker_threads";
import type {
  MainToWorkerMessage,
  MsgDecodeStart,
  MsgEncodeStart,
  MsgDecodeChunk,
  MsgDecodeClose,
  MsgDecodeCancel,
  MsgDecodePause,
  MsgDecodeResume,
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
// Queued-message types (messages arriving while a session start is in-flight)
// ---------------------------------------------------------------------------

type QueuedDecodeMessage =
  | MsgDecodeChunk
  | MsgDecodeClose
  | MsgDecodeCancel
  | MsgDecodePause
  | MsgDecodeResume;

type QueuedEncodeMessage =
  | MsgEncodePixels
  | MsgEncodeFinish
  | MsgEncodeCancel;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const decodeSessions = new Map<string, DecodeHandler>();
const encodeSessions = new Map<string, EncodeHandler>();
const pendingDecodeStarts = new Map<string, Promise<void>>();
const pendingEncodeStarts = new Map<string, Promise<void>>();
const queuedDecodeMessages = new Map<string, QueuedDecodeMessage[]>();
const queuedEncodeMessages = new Map<string, QueuedEncodeMessage[]>();
const queuedDecodeBytes = new Map<string, number>();
const queuedEncodeBytes = new Map<string, number>();

// Sessions whose pending start was cancelled (overflow or release_state) before backend init
// completed. Guards against zombie handler creation when the start promise eventually resolves.
const cancelledPendingStarts = new Set<string>();

let shuttingDown = false;
let shutdownPromise: Promise<void> | null = null;
let backend: Backend | null = null;
let backendPromise: Promise<Backend> | null = null;

const MAX_QUEUED_MESSAGES_PER_SESSION = 256;
const MAX_QUEUED_BYTES_PER_SESSION = 128 * 1024 * 1024;
const FORCE_EXIT_AFTER_SHUTDOWN_MS = 1_000;

// ---------------------------------------------------------------------------
// Backend selection (native vs WASM)
// ---------------------------------------------------------------------------

// Shared promise ensures startup and any concurrent first-session call race-free
// through a single selectBackend() invocation. Cleared on failure to allow retry.
async function initBackend(): Promise<Backend> {
  if (backend !== null) return backend;
  if (backendPromise === null) {
    backendPromise = selectBackend()
      .then((b) => {
        backend = b;
        return b;
      })
      .catch((err) => {
        backendPromise = null;
        throw err;
      });
  }
  return backendPromise;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function formatError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}

function safePostMessage(msg: unknown): void {
  if (shuttingDown) return;
  try {
    port.postMessage(msg);
  } catch {
    // port may already be closed during late shutdown callbacks
  }
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

function hasAnySession(sessionId: string): boolean {
  return (
    decodeSessions.has(sessionId) ||
    encodeSessions.has(sessionId) ||
    pendingDecodeStarts.has(sessionId) ||
    pendingEncodeStarts.has(sessionId)
  );
}

function clearQueuedDecode(sessionId: string): void {
  queuedDecodeMessages.delete(sessionId);
  queuedDecodeBytes.delete(sessionId);
}

function clearQueuedEncode(sessionId: string): void {
  queuedEncodeMessages.delete(sessionId);
  queuedEncodeBytes.delete(sessionId);
}

function failPendingDecode(sessionId: string, code: string, message: string): void {
  cancelledPendingStarts.add(sessionId);
  pendingDecodeStarts.delete(sessionId);
  clearQueuedDecode(sessionId);
  port.postMessage({ type: "decode_error", sessionId, code, message });
}

function failPendingEncode(sessionId: string, code: string, message: string): void {
  cancelledPendingStarts.add(sessionId);
  pendingEncodeStarts.delete(sessionId);
  clearQueuedEncode(sessionId);
  port.postMessage({ type: "encode_error", sessionId, code, message });
}

function queueDecodeMessage(sessionId: string, msg: QueuedDecodeMessage): void {
  let queue = queuedDecodeMessages.get(sessionId);
  if (queue === undefined) {
    queue = [];
    queuedDecodeMessages.set(sessionId, queue);
  }
  if (queue.length >= MAX_QUEUED_MESSAGES_PER_SESSION) {
    failPendingDecode(sessionId, "QueueOverflow",
      `Cold-start message queue exceeded ${MAX_QUEUED_MESSAGES_PER_SESSION} messages`);
    return;
  }
  if (msg.type === "decode_chunk") {
    const nextBytes = (queuedDecodeBytes.get(sessionId) ?? 0) + msg.chunk.byteLength;
    if (nextBytes > MAX_QUEUED_BYTES_PER_SESSION) {
      failPendingDecode(sessionId, "QueueOverflow",
        `Cold-start decode queue exceeded ${MAX_QUEUED_BYTES_PER_SESSION >> 20} MiB`);
      return;
    }
    queuedDecodeBytes.set(sessionId, nextBytes);
  }
  queue.push(msg);
}

function queueEncodeMessage(sessionId: string, msg: QueuedEncodeMessage): void {
  let queue = queuedEncodeMessages.get(sessionId);
  if (queue === undefined) {
    queue = [];
    queuedEncodeMessages.set(sessionId, queue);
  }
  if (queue.length >= MAX_QUEUED_MESSAGES_PER_SESSION) {
    failPendingEncode(sessionId, "QueueOverflow",
      `Cold-start message queue exceeded ${MAX_QUEUED_MESSAGES_PER_SESSION} messages`);
    return;
  }
  if (msg.type === "encode_pixels") {
    const nextBytes = (queuedEncodeBytes.get(sessionId) ?? 0) + msg.chunk.byteLength;
    if (nextBytes > MAX_QUEUED_BYTES_PER_SESSION) {
      failPendingEncode(sessionId, "QueueOverflow",
        `Cold-start encode queue exceeded ${MAX_QUEUED_BYTES_PER_SESSION >> 20} MiB`);
      return;
    }
    queuedEncodeBytes.set(sessionId, nextBytes);
  }
  queue.push(msg);
}

function flushQueuedDecodeMessages(sessionId: string, handler: DecodeHandler): void {
  const queue = queuedDecodeMessages.get(sessionId);
  if (queue === undefined) return;
  clearQueuedDecode(sessionId);
  for (const msg of queue) {
    switch (msg.type) {
      case "decode_chunk":  handler.onChunk(msg.chunk);            break;
      case "decode_close":  handler.onClose();                     break;
      case "decode_cancel": void handler.onCancel(msg.reason);     break;
      case "decode_pause":  handler.onPause();                     break;
      case "decode_resume": handler.onResume();                    break;
    }
  }
}

function flushQueuedEncodeMessages(sessionId: string, handler: EncodeHandler): void {
  const queue = queuedEncodeMessages.get(sessionId);
  if (queue === undefined) return;
  clearQueuedEncode(sessionId);
  for (const msg of queue) {
    switch (msg.type) {
      case "encode_pixels": handler.onPixels(msg.chunk, msg.region); break;
      case "encode_finish": handler.onFinish();                      break;
      case "encode_cancel": void handler.onCancel(msg.reason);       break;
    }
  }
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
      const handler = decodeSessions.get(m.sessionId);
      if (handler !== undefined) {
        handler.onChunk(m.chunk);
      } else if (pendingDecodeStarts.has(m.sessionId)) {
        queueDecodeMessage(m.sessionId, m);
      }
      break;
    }

    case "decode_close": {
      const handler = decodeSessions.get(msg.sessionId);
      if (handler !== undefined) {
        handler.onClose();
      } else if (pendingDecodeStarts.has(msg.sessionId)) {
        queueDecodeMessage(msg.sessionId, msg);
      }
      break;
    }

    case "decode_cancel": {
      const m = msg as MsgDecodeCancel;
      const handler = decodeSessions.get(m.sessionId);
      if (handler !== undefined) {
        void handler.onCancel(m.reason);
      } else if (pendingDecodeStarts.has(m.sessionId)) {
        queueDecodeMessage(m.sessionId, m);
      }
      break;
    }

    case "decode_pause": {
      const handler = decodeSessions.get(msg.sessionId);
      if (handler !== undefined) {
        handler.onPause();
      } else if (pendingDecodeStarts.has(msg.sessionId)) {
        queueDecodeMessage(msg.sessionId, msg as MsgDecodePause);
      }
      break;
    }

    case "decode_resume": {
      const handler = decodeSessions.get(msg.sessionId);
      if (handler !== undefined) {
        handler.onResume();
      } else if (pendingDecodeStarts.has(msg.sessionId)) {
        queueDecodeMessage(msg.sessionId, msg as MsgDecodeResume);
      }
      break;
    }

    case "encode_start":
      void handleEncodeStart(msg);
      break;

    case "encode_pixels": {
      const m = msg as MsgEncodePixels;
      const handler = encodeSessions.get(m.sessionId);
      if (handler !== undefined) {
        handler.onPixels(m.chunk, m.region);
      } else if (pendingEncodeStarts.has(m.sessionId)) {
        queueEncodeMessage(m.sessionId, m);
      }
      break;
    }

    case "encode_finish": {
      const handler = encodeSessions.get(msg.sessionId);
      if (handler !== undefined) {
        handler.onFinish();
      } else if (pendingEncodeStarts.has(msg.sessionId)) {
        queueEncodeMessage(msg.sessionId, msg as MsgEncodeFinish);
      }
      break;
    }

    case "encode_cancel": {
      const m = msg as MsgEncodeCancel;
      const handler = encodeSessions.get(m.sessionId);
      if (handler !== undefined) {
        void handler.onCancel(m.reason);
      } else if (pendingEncodeStarts.has(m.sessionId)) {
        queueEncodeMessage(m.sessionId, m);
      }
      break;
    }

    case "worker_shutdown":
      void handleShutdown();
      break;

    case "release_state":
      void releaseSessionState(msg.sessionId);
      break;

    default:
      break;
  }
});

// ---------------------------------------------------------------------------
// Decode session start
// ---------------------------------------------------------------------------

async function handleDecodeStart(msg: MsgDecodeStart): Promise<void> {
  if (hasAnySession(msg.sessionId)) {
    port.postMessage({
      type: "decode_error",
      sessionId: msg.sessionId,
      code: "DuplicateSession",
      message: `Session already exists: ${msg.sessionId}`,
    });
    return;
  }

  const startPromise = (async () => {
    let b: Backend;
    try {
      b = await initBackend();
    } catch (err) {
      pendingDecodeStarts.delete(msg.sessionId);
      clearQueuedDecode(msg.sessionId);
      if (!cancelledPendingStarts.delete(msg.sessionId)) {
        port.postMessage({
          type: "decode_error",
          sessionId: msg.sessionId,
          code: "CapabilityMissing",
          message: `Backend init failed: ${formatError(err)}`,
        });
      }
      return;
    }

    pendingDecodeStarts.delete(msg.sessionId);

    if (shuttingDown || cancelledPendingStarts.delete(msg.sessionId)) {
      clearQueuedDecode(msg.sessionId);
      return;
    }

    const handler = new DecodeHandler(msg, b, {
      onSessionEnd: (id) => decodeSessions.delete(id),
      port,
    });
    decodeSessions.set(msg.sessionId, handler);
    flushQueuedDecodeMessages(msg.sessionId, handler);
  })();

  pendingDecodeStarts.set(msg.sessionId, startPromise);
}

// ---------------------------------------------------------------------------
// Encode session start
// ---------------------------------------------------------------------------

async function handleEncodeStart(msg: MsgEncodeStart): Promise<void> {
  if (hasAnySession(msg.sessionId)) {
    port.postMessage({
      type: "encode_error",
      sessionId: msg.sessionId,
      code: "DuplicateSession",
      message: `Session already exists: ${msg.sessionId}`,
    });
    return;
  }

  const startPromise = (async () => {
    let b: Backend;
    try {
      b = await initBackend();
    } catch (err) {
      pendingEncodeStarts.delete(msg.sessionId);
      clearQueuedEncode(msg.sessionId);
      if (!cancelledPendingStarts.delete(msg.sessionId)) {
        port.postMessage({
          type: "encode_error",
          sessionId: msg.sessionId,
          code: "CapabilityMissing",
          message: `Backend init failed: ${formatError(err)}`,
        });
      }
      return;
    }

    pendingEncodeStarts.delete(msg.sessionId);

    if (shuttingDown || cancelledPendingStarts.delete(msg.sessionId)) {
      clearQueuedEncode(msg.sessionId);
      return;
    }

    const handler = new EncodeHandler(msg, b, {
      onSessionEnd: (id) => encodeSessions.delete(id),
      port,
    });
    encodeSessions.set(msg.sessionId, handler);
    flushQueuedEncodeMessages(msg.sessionId, handler);
  })();

  pendingEncodeStarts.set(msg.sessionId, startPromise);
}

// ---------------------------------------------------------------------------
// Release session state
// ---------------------------------------------------------------------------

async function releaseSessionState(sessionId: string): Promise<void> {
  cancelledPendingStarts.add(sessionId);
  pendingDecodeStarts.delete(sessionId);
  pendingEncodeStarts.delete(sessionId);
  clearQueuedDecode(sessionId);
  clearQueuedEncode(sessionId);

  const decode = decodeSessions.get(sessionId);
  if (decode !== undefined) {
    decodeSessions.delete(sessionId);
    await decode.onCancel("release_state").catch(() => undefined);
  }

  const encode = encodeSessions.get(sessionId);
  if (encode !== undefined) {
    encodeSessions.delete(sessionId);
    await encode.onCancel("release_state").catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Graceful shutdown (idempotent)
// ---------------------------------------------------------------------------

function handleShutdown(): Promise<void> {
  if (shutdownPromise !== null) return shutdownPromise;
  shutdownPromise = doShutdown();
  return shutdownPromise;
}

async function doShutdown(): Promise<void> {
  shuttingDown = true;

  // Wait for any in-flight session starts before cancelling their handlers.
  await Promise.allSettled([
    ...pendingDecodeStarts.values(),
    ...pendingEncodeStarts.values(),
  ]);

  const cancelPromises: Promise<void>[] = [];
  for (const [, h] of decodeSessions) cancelPromises.push(h.onCancel("worker_shutdown").catch(() => undefined));
  for (const [, h] of encodeSessions) cancelPromises.push(h.onCancel("worker_shutdown").catch(() => undefined));
  await Promise.allSettled(cancelPromises);

  decodeSessions.clear();
  encodeSessions.clear();
  pendingDecodeStarts.clear();
  pendingEncodeStarts.clear();
  queuedDecodeMessages.clear();
  queuedEncodeMessages.clear();
  queuedDecodeBytes.clear();
  queuedEncodeBytes.clear();
  cancelledPendingStarts.clear();

  const ack: MsgWorkerShutdownAck = { type: "worker_shutdown_ack" };
  port.postMessage(ack);
  port.close();

  // Fallback: force-exit if the event loop doesn't drain naturally.
  setTimeout(() => {
    process.exit(0);
  }, FORCE_EXIT_AFTER_SHUTDOWN_MS).unref();
}

// ---------------------------------------------------------------------------
// Uncaught error reporting
// ---------------------------------------------------------------------------

process.on("uncaughtException", (err: Error) => {
  safePostMessage({
    type: "worker_error",
    code: "UnhandledError",
    message: err.message,
  });
});

process.on("unhandledRejection", (reason: unknown) => {
  safePostMessage({
    type: "worker_error",
    code: "UnhandledRejection",
    message: reason instanceof Error ? reason.message : String(reason),
  });
});

// ---------------------------------------------------------------------------
// Startup: select backend and post worker_ready
// ---------------------------------------------------------------------------

void (async () => {
  let backendType: MsgWorkerReady["backend"] = "wasm";
  try {
    const b = await initBackend();
    backendType = b.type;
  } catch {
    // Keep reporting wasm as the intended fallback if backend init failed.
    // The first actual session will report CapabilityMissing if it still cannot initialise.
  }
  const ready: MsgWorkerReady = { type: "worker_ready", backend: backendType };
  port.postMessage(ready);
})();
