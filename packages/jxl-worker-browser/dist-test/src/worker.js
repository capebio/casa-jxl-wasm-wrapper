// jxl-worker-browser/src/worker.ts
// DedicatedWorker host for WASM codec sessions.
// Spec: Section 26 T-WORKER-BROWSER brief, Sections 10/11/16.
//
// This file is the worker entry point. It owns the WASM module lifecycle and
// routes messages by sessionId to decode or encode handlers.
// The WASM codec (jxl-wasm) is imported dynamically; stubs are used until
// T-WASM-BUILD lands and provides real artifacts.
import { DecodeHandler } from "./decode-handler.js";
import { EncodeHandler } from "./encode-handler.js";
import { loadWasmModule, detectTier } from "./wasm-loader.js";
// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const decodeSessions = new Map();
const encodeSessions = new Map();
const pendingDecodeStarts = new Map();
const pendingEncodeStarts = new Map();
const queuedDecodeMessages = new Map();
const queuedEncodeMessages = new Map();
let wasmModule = null;
let wasmLoadPromise = null;
let shuttingDown = false;
let shutdownPromise = null;
// Cap per session to avoid unbounded cold-start buffering.
const MAX_QUEUED_MESSAGES_PER_SESSION = 256;
// ---------------------------------------------------------------------------
// WASM acquisition (lazy, singleton; resets on failure to allow retry)
// ---------------------------------------------------------------------------
async function getWasm() {
    if (wasmModule !== null)
        return wasmModule;
    if (wasmLoadPromise === null) {
        wasmLoadPromise = loadWasmModule(resolvedWasmUrl())
            .then((m) => {
            wasmModule = m;
            return m;
        })
            .catch((err) => {
            wasmLoadPromise = null;
            throw err;
        });
    }
    return wasmLoadPromise;
}
let _wasmUrl = null;
function resolvedWasmUrl() {
    if (_wasmUrl !== null)
        return _wasmUrl;
    _wasmUrl = new URL("./jxl-core.wasm", self.location.href).href;
    return _wasmUrl;
}
// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------
function hasAnySession(sessionId) {
    return (decodeSessions.has(sessionId) ||
        encodeSessions.has(sessionId) ||
        pendingDecodeStarts.has(sessionId) ||
        pendingEncodeStarts.has(sessionId));
}
function queueDecodeMessage(sessionId, msg) {
    let queue = queuedDecodeMessages.get(sessionId);
    if (queue === undefined) {
        queue = [];
        queuedDecodeMessages.set(sessionId, queue);
    }
    if (queue.length >= MAX_QUEUED_MESSAGES_PER_SESSION) {
        queuedDecodeMessages.delete(sessionId);
        pendingDecodeStarts.delete(sessionId);
        self.postMessage({
            type: "decode_error",
            sessionId,
            code: "QueueOverflow",
            message: `Cold-start message queue exceeded ${MAX_QUEUED_MESSAGES_PER_SESSION} messages for session ${sessionId}`,
        });
        return;
    }
    queue.push(msg);
}
function queueEncodeMessage(sessionId, msg) {
    let queue = queuedEncodeMessages.get(sessionId);
    if (queue === undefined) {
        queue = [];
        queuedEncodeMessages.set(sessionId, queue);
    }
    if (queue.length >= MAX_QUEUED_MESSAGES_PER_SESSION) {
        queuedEncodeMessages.delete(sessionId);
        pendingEncodeStarts.delete(sessionId);
        self.postMessage({
            type: "encode_error",
            sessionId,
            code: "QueueOverflow",
            message: `Cold-start message queue exceeded ${MAX_QUEUED_MESSAGES_PER_SESSION} messages for session ${sessionId}`,
        });
        return;
    }
    queue.push(msg);
}
function flushQueuedDecodeMessages(sessionId, handler) {
    const queue = queuedDecodeMessages.get(sessionId);
    if (queue === undefined)
        return;
    queuedDecodeMessages.delete(sessionId);
    for (const msg of queue) {
        routeToDecodeHandler(handler, msg);
    }
}
function flushQueuedEncodeMessages(sessionId, handler) {
    const queue = queuedEncodeMessages.get(sessionId);
    if (queue === undefined)
        return;
    queuedEncodeMessages.delete(sessionId);
    for (const msg of queue) {
        routeToEncodeHandler(handler, msg);
    }
}
// ---------------------------------------------------------------------------
// Per-type dispatch and lookup-or-queue routing
// ---------------------------------------------------------------------------
function routeToDecodeHandler(handler, msg) {
    switch (msg.type) {
        case "decode_chunk":
            handler.onChunk(msg.chunk);
            break;
        case "decode_close":
            handler.onClose();
            break;
        case "decode_cancel":
            void handler.onCancel(msg.reason);
            break;
        case "decode_pause":
            handler.onPause();
            break;
        case "decode_resume":
            handler.onResume();
            break;
    }
}
function routeToEncodeHandler(handler, msg) {
    switch (msg.type) {
        case "encode_pixels":
            handler.onPixels(msg.chunk, msg.region);
            break;
        case "encode_finish":
            handler.onFinish();
            break;
        case "encode_cancel":
            void handler.onCancel(msg.reason);
            break;
    }
}
function routeDecodeMessage(msg) {
    const handler = decodeSessions.get(msg.sessionId);
    if (handler !== undefined) {
        routeToDecodeHandler(handler, msg);
    }
    else if (pendingDecodeStarts.has(msg.sessionId)) {
        queueDecodeMessage(msg.sessionId, msg);
    }
}
function routeEncodeMessage(msg) {
    const handler = encodeSessions.get(msg.sessionId);
    if (handler !== undefined) {
        routeToEncodeHandler(handler, msg);
    }
    else if (pendingEncodeStarts.has(msg.sessionId)) {
        queueEncodeMessage(msg.sessionId, msg);
    }
}
function handleReleaseState(sessionId) {
    const decode = decodeSessions.get(sessionId);
    if (decode !== undefined) {
        void decode.onCancel("release_state").catch(() => undefined);
        decodeSessions.delete(sessionId);
    }
    const encode = encodeSessions.get(sessionId);
    if (encode !== undefined) {
        void encode.onCancel("release_state").catch(() => undefined);
        encodeSessions.delete(sessionId);
    }
    pendingDecodeStarts.delete(sessionId);
    pendingEncodeStarts.delete(sessionId);
    queuedDecodeMessages.delete(sessionId);
    queuedEncodeMessages.delete(sessionId);
}
// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------
self.onmessage = (ev) => {
    const msg = ev.data;
    if (shuttingDown && msg.type !== "worker_shutdown") {
        return;
    }
    switch (msg.type) {
        case "decode_start":
            void handleDecodeStart(msg);
            break;
        case "decode_chunk":
        case "decode_close":
        case "decode_cancel":
        case "decode_pause":
        case "decode_resume":
            routeDecodeMessage(msg);
            break;
        case "encode_start":
            void handleEncodeStart(msg);
            break;
        case "encode_pixels":
        case "encode_finish":
        case "encode_cancel":
            routeEncodeMessage(msg);
            break;
        case "release_state":
            handleReleaseState(msg.sessionId);
            break;
        case "worker_shutdown":
            void handleShutdown();
            break;
        default:
            break;
    }
};
// ---------------------------------------------------------------------------
// Decode session start
// ---------------------------------------------------------------------------
async function handleDecodeStart(msg) {
    if (hasAnySession(msg.sessionId)) {
        self.postMessage({
            type: "decode_error",
            sessionId: msg.sessionId,
            code: "DuplicateSession",
            message: `Session already exists: ${msg.sessionId}`,
        });
        return;
    }
    // Register in pendingDecodeStarts BEFORE awaiting getWasm() so that any
    // messages arriving while WASM is loading are correctly queued by
    // routeDecodeMessage. If the set() came after the async IIFE, a synchronous
    // (warm-cache) resolution of getWasm() would finish the entire body before
    // the map entry existed, causing those in-flight messages to be silently dropped.
    let resolveStartPromise;
    const startPromise = new Promise((resolve) => { resolveStartPromise = resolve; });
    pendingDecodeStarts.set(msg.sessionId, startPromise);
    (async () => {
        let wasm;
        try {
            wasm = await getWasm();
        }
        catch (err) {
            pendingDecodeStarts.delete(msg.sessionId);
            queuedDecodeMessages.delete(msg.sessionId);
            resolveStartPromise();
            self.postMessage({
                type: "decode_error",
                sessionId: msg.sessionId,
                code: "CapabilityMissing",
                message: `WASM module failed to load: ${String(err)}`,
            });
            return;
        }
        pendingDecodeStarts.delete(msg.sessionId);
        if (shuttingDown) {
            queuedDecodeMessages.delete(msg.sessionId);
            resolveStartPromise();
            return;
        }
        const handler = new DecodeHandler(msg, wasm, {
            onSessionEnd: (sessionId) => decodeSessions.delete(sessionId),
        });
        decodeSessions.set(msg.sessionId, handler);
        flushQueuedDecodeMessages(msg.sessionId, handler);
        resolveStartPromise();
    })().catch((err) => {
        pendingDecodeStarts.delete(msg.sessionId);
        queuedDecodeMessages.delete(msg.sessionId);
        resolveStartPromise();
        self.postMessage({
            type: "decode_error",
            sessionId: msg.sessionId,
            code: "Internal",
            message: `Unexpected error starting decode session: ${String(err)}`,
        });
    });
}
// ---------------------------------------------------------------------------
// Encode session start
// ---------------------------------------------------------------------------
async function handleEncodeStart(msg) {
    if (hasAnySession(msg.sessionId)) {
        self.postMessage({
            type: "encode_error",
            sessionId: msg.sessionId,
            code: "DuplicateSession",
            message: `Session already exists: ${msg.sessionId}`,
        });
        return;
    }
    // Register in pendingEncodeStarts BEFORE awaiting getWasm() — same race as
    // handleDecodeStart: a warm-cache synchronous resolution would complete the
    // entire IIFE before a trailing set(), silently dropping in-flight messages.
    let resolveStartPromise;
    const startPromise = new Promise((resolve) => { resolveStartPromise = resolve; });
    pendingEncodeStarts.set(msg.sessionId, startPromise);
    (async () => {
        let wasm;
        try {
            wasm = await getWasm();
        }
        catch (err) {
            pendingEncodeStarts.delete(msg.sessionId);
            queuedEncodeMessages.delete(msg.sessionId);
            resolveStartPromise();
            self.postMessage({
                type: "encode_error",
                sessionId: msg.sessionId,
                code: "CapabilityMissing",
                message: `WASM module failed to load: ${String(err)}`,
            });
            return;
        }
        pendingEncodeStarts.delete(msg.sessionId);
        if (shuttingDown) {
            queuedEncodeMessages.delete(msg.sessionId);
            resolveStartPromise();
            return;
        }
        const handler = new EncodeHandler(msg, wasm, {
            onSessionEnd: (sessionId) => encodeSessions.delete(sessionId),
        });
        encodeSessions.set(msg.sessionId, handler);
        flushQueuedEncodeMessages(msg.sessionId, handler);
        resolveStartPromise();
    })().catch((err) => {
        pendingEncodeStarts.delete(msg.sessionId);
        queuedEncodeMessages.delete(msg.sessionId);
        resolveStartPromise();
        self.postMessage({
            type: "encode_error",
            sessionId: msg.sessionId,
            code: "Internal",
            message: `Unexpected error starting encode session: ${String(err)}`,
        });
    });
}
// ---------------------------------------------------------------------------
// Graceful shutdown (idempotent)
// ---------------------------------------------------------------------------
function handleShutdown() {
    if (shutdownPromise !== null)
        return shutdownPromise;
    shutdownPromise = doShutdown();
    return shutdownPromise;
}
async function doShutdown() {
    shuttingDown = true;
    // Wait for any in-flight session starts before cancelling their handlers.
    await Promise.allSettled([
        ...pendingDecodeStarts.values(),
        ...pendingEncodeStarts.values(),
    ]);
    const cancelPromises = [];
    for (const handler of decodeSessions.values()) {
        cancelPromises.push(handler.onCancel("worker_shutdown").catch(() => undefined));
    }
    for (const handler of encodeSessions.values()) {
        cancelPromises.push(handler.onCancel("worker_shutdown").catch(() => undefined));
    }
    await Promise.allSettled(cancelPromises);
    decodeSessions.clear();
    encodeSessions.clear();
    pendingDecodeStarts.clear();
    pendingEncodeStarts.clear();
    queuedDecodeMessages.clear();
    queuedEncodeMessages.clear();
    wasmModule = null;
    wasmLoadPromise = null;
    const ack = { type: "worker_shutdown_ack" };
    self.postMessage(ack);
    self.close();
}
// ---------------------------------------------------------------------------
// Uncaught error reporting
// ---------------------------------------------------------------------------
self.addEventListener("error", (event) => {
    self.postMessage({
        type: "worker_error",
        code: "UnhandledError",
        message: event.message ?? "Unknown worker error",
    });
});
self.addEventListener("unhandledrejection", (event) => {
    self.postMessage({
        type: "worker_error",
        code: "UnhandledRejection",
        message: event.reason instanceof Error ? event.reason.message : String(event.reason),
    });
});
// ---------------------------------------------------------------------------
// Startup announcement
// ---------------------------------------------------------------------------
const ready = { type: "worker_ready", backend: "wasm", wasmBuild: detectTier() };
self.postMessage(ready);
//# sourceMappingURL=worker.js.map