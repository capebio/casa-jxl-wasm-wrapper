// jxl-worker-node/src/encode-handler.ts
// Encode session handler for node:worker_threads.
// BLOCKED on T-NATIVE-BIND + T-ENCODE-NATIVE for real codec calls.
export class EncodeHandler {
    sessionId;
    opts;
    backend;
    port;
    callbacks;
    state = "created";
    pixelQueue = [];
    cancelled = false;
    finished = false;
    constructor(opts, backend, callbacks) {
        this.sessionId = opts.sessionId;
        this.opts = opts;
        this.backend = backend;
        this.port = callbacks.port;
        this.callbacks = callbacks;
        this.run().catch((err) => this.failSession("Internal", String(err)));
    }
    onPixels(chunk, region) {
        if (this.cancelled || this.state === "done")
            return;
        const buf = Buffer.from(chunk instanceof ArrayBuffer ? chunk : chunk.buffer, chunk instanceof ArrayBuffer ? 0 : chunk.byteOffset, chunk instanceof ArrayBuffer ? chunk.byteLength : chunk.byteLength);
        const entry = { chunk: buf };
        if (region !== undefined)
            entry.region = region;
        this.pixelQueue.push(entry);
    }
    onFinish() {
        this.finished = true;
    }
    async onCancel(reason) {
        if (this.cancelled)
            return;
        this.cancelled = true;
        this.state = "cancelled";
        const msg = { type: "encode_cancelled", sessionId: this.sessionId };
        this.port.postMessage(msg);
        this.callbacks.onSessionEnd(this.sessionId);
    }
    async run() {
        // STUB: real impl provided by T-ENCODE-NATIVE.
        await this.waitForPixels();
        if (this.cancelled)
            return;
        this.failSession("Internal", "[jxl-worker-node] encode stub: awaiting T-ENCODE-NATIVE.");
    }
    waitForPixels() {
        return new Promise((resolve) => {
            const check = () => {
                if (this.pixelQueue.length > 0 || this.finished || this.cancelled)
                    resolve();
                else
                    setTimeout(check, 2);
            };
            check();
        });
    }
    failSession(code, message) {
        if (this.cancelled || this.state === "done")
            return;
        this.state = "error";
        const msg = { type: "encode_error", sessionId: this.sessionId, code, message };
        this.port.postMessage(msg);
        this.callbacks.onSessionEnd(this.sessionId);
    }
}
//# sourceMappingURL=encode-handler.js.map