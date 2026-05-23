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

let shuttingDown = false;
let shutdownPromise: Promise<void> | null = null;
let backend: Backend | null = null;

const MAX_QUEUED_MESSAGES_PER_SESSION = 256;

// ---------------------------------------------------------------------------
// Backend selection (native vs WASM)
// ---------------------------------------------------------------------------

async function initBackend(): Promise<Backend> {
  if (backend !== null) return backend;
  backend = await selectBackend();
  return backend;
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

function queueDecodeMessage(sessionId: string, msg: QueuedDecodeMessage): void {
  let queue = queuedDecodeMessages.get(sessionId);
  if (queue === undefined) {
    queue = [];
    queuedDecodeMessages.set(sessionId, queue);
  }
  if (queue.length >= MAX_QUEUED_MESSAGES_PER_SESSION) {
    queuedDecodeMessages.delete(sessionId);
    pendingDecodeStarts.delete(sessionId);
    port.postMessage({
      type: "decode_error",
      sessionId,
      code: "QueueOverflow",
      message: `Cold-start message queue exceeded ${MAX_QUEUED_MESSAGES_PER_SESSION} messages`,
    });
    return;
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
    queuedEncodeMessages.delete(sessionId);
    pendingEncodeStarts.delete(sessionId);
    port.postMessage({
      type: "encode_error",
      sessionId,
      code: "QueueOverflow",
      message: `Cold-start message queue exceeded ${MAX_QUEUED_MESSAGES_PER_SESSION} messages`,
    });
    return;
  }
  queue.push(msg);
}

function flushQueuedDecodeMessages(sessionId: string, handler: DecodeHandler): void {
  const queue = queuedDecodeMessages.get(sessionId);
  if (queue === undefined) return;
  queuedDecodeMessages.delete(sessionId);
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
  queuedEncodeMessages.delete(sessionId);
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

    case "release_state": {
      const { sessionId } = msg;
      const decode = decodeSessions.get(sessionId);
      if (decode !== undefined) {
        decodeSessions.delete(sessionId);
        void decode.onCancel("release_state").catch(() => undefined);
      }
      const encode = encodeSessions.get(sessionId);
      if (encode !== undefined) {
        encodeSessions.delete(sessionId);
        void encode.onCancel("release_state").catch(() => undefined);
      }
      queuedDecodeMessages.delete(sessionId);
      queuedEncodeMessages.delete(sessionId);
      break;
    }

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
      queuedDecodeMessages.delete(msg.sessionId);
      port.postMessage({
        type: "decode_error",
        sessionId: msg.sessionId,
        code: "CapabilityMissing",
        message: `Backend init failed: ${String(err)}`,
      });
      return;
    }

    pendingDecodeStarts.delete(msg.sessionId);

    if (shuttingDown) {
      queuedDecodeMessages.delete(msg.sessionId);
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
      queuedEncodeMessages.delete(msg.sessionId);
      port.postMessage({
        type: "encode_error",
        sessionId: msg.sessionId,
        code: "CapabilityMissing",
        message: `Backend init failed: ${String(err)}`,
      });
      return;
    }

    pendingEncodeStarts.delete(msg.sessionId);

    if (shuttingDown) {
      queuedEncodeMessages.delete(msg.sessionId);
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

  const ack: MsgWorkerShutdownAck = { type: "worker_shutdown_ack" };
  port.postMessage(ack);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Uncaught error reporting
// ---------------------------------------------------------------------------

process.on("uncaughtException", (err: Error) => {
  port.postMessage({
    type: "worker_error",
    code: "UnhandledError",
    message: err.message,
  });
});

process.on("unhandledRejection", (reason: unknown) => {
  port.postMessage({
    type: "worker_error",
    code: "UnhandledRejection",
    message: reason instanceof Error ? reason.message : String(reason),
  });
});

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
  backend = b;
})();
