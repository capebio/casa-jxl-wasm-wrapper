// jxl-worker-node/src/decode-handler.ts
// Decode session handler for node:worker_threads.
// Same protocol as jxl-worker-browser/decode-handler.ts.
// BLOCKED on T-NATIVE-BIND + T-DECODE-NATIVE for real codec calls.
const CHUNK_HWM = 4;
export class DecodeHandler {
    sessionId;
    opts;
    backend;
    port;
    callbacks;
    state = "created";
    chunkQueue = [];
    queueDepth = 0;
    cancelled = false;
    inputClosed = false;
    constructor(opts, backend, callbacks) {
        this.sessionId = opts.sessionId;
        this.opts = opts;
        this.backend = backend;
        this.port = callbacks.port;
        this.callbacks = callbacks;
        this.run().catch((err) => this.failSession("Internal", String(err)));
    }
    // Accept both Buffer and Uint8Array per spec Section 15.2
    onChunk(chunk) {
        if (this.cancelled || this.state === "final")
            return;
        const buf = Buffer.from(chunk instanceof ArrayBuffer ? chunk : chunk.buffer, chunk instanceof ArrayBuffer ? 0 : chunk.byteOffset, chunk instanceof ArrayBuffer ? chunk.byteLength : chunk.byteLength);
        this.chunkQueue.push(buf);
        this.queueDepth++;
    }
    onClose() {
        this.inputClosed = true;
    }
    async onCancel(reason) {
        if (this.cancelled)
            return;
        this.cancelled = true;
        this.state = "cancelled";
        const msg = { type: "decode_cancelled", sessionId: this.sessionId };
        this.port.postMessage(msg);
        this.callbacks.onSessionEnd(this.sessionId);
    }
    async run() {
        // STUB: real impl provided by T-DECODE-NATIVE.
        //
        // Real flow for native backend:
        //   Same event loop as T-DECODE-WASM but calling jxl-native C++ binding directly.
        //   Emit Buffer on output side (not ArrayBuffer) per spec Section 15.2.
        //
        // Real flow for wasm backend:
        //   Same as jxl-worker-browser/decode-handler.ts but in Node environment.
        await this.waitForChunk();
        if (this.cancelled)
            return;
        this.state = "headers";
        const stubInfo = {
            width: 0, height: 0, bitsPerSample: 8,
            hasAlpha: false, hasAnimation: false, jpegReconstructionAvailable: false,
        };
        const headerMsg = {
            type: "decode_header", sessionId: this.sessionId, info: stubInfo,
        };
        this.port.postMessage(headerMsg);
        if (this.opts.progressionTarget === "header") {
            this.state = "final";
            this.callbacks.onSessionEnd(this.sessionId);
            return;
        }
        this.failSession("Internal", "[jxl-worker-node] decode stub: awaiting T-DECODE-NATIVE.");
    }
    waitForChunk() {
        return new Promise((resolve) => {
            const check = () => {
                if (this.chunkQueue.length > 0 || this.inputClosed || this.cancelled) {
                    resolve();
                }
                else {
                    setTimeout(check, 2);
                }
            };
            check();
        });
    }
    failSession(code, message) {
        if (this.cancelled || this.state === "final")
            return;
        this.state = "error";
        const msg = { type: "decode_error", sessionId: this.sessionId, code, message };
        this.port.postMessage(msg);
        this.callbacks.onSessionEnd(this.sessionId);
    }
}
//# sourceMappingURL=decode-handler.js.map