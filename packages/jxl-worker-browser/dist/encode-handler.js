// jxl-worker-browser/src/encode-handler.ts
// Encode session handler. Owns one libjxl encoder instance per session.
// Spec: Sections 11, 16.2.
//
// Drives the WASM codec facade; generated libjxl adapter lands with T-WASM-BUILD.
const CHUNK_HWM = 4;
export class EncodeHandler {
    sessionId;
    opts;
    wasm;
    callbacks;
    state = "created";
    pixelQueue = [];
    queueDepth = 0;
    cancelled = false;
    finished = false;
    firstByteEmitted = false;
    constructor(opts, wasm, callbacks) {
        this.sessionId = opts.sessionId;
        this.opts = opts;
        this.wasm = wasm;
        this.callbacks = callbacks;
        this.run().catch((err) => this.failSession("Internal", String(err)));
    }
    // ---------------------------------------------------------------------------
    // Incoming message handlers
    // ---------------------------------------------------------------------------
    onPixels(chunk, region) {
        if (this.cancelled || this.state === "done")
            return;
        const entry = { chunk };
        if (region !== undefined)
            entry.region = region;
        this.pixelQueue.push(entry);
        this.queueDepth++;
    }
    onFinish() {
        this.finished = true;
    }
    async onCancel(reason) {
        if (this.cancelled)
            return;
        this.cancelled = true;
        this.state = "cancelled";
        const msg = {
            type: "encode_cancelled",
            sessionId: this.sessionId,
        };
        self.postMessage(msg);
        this.callbacks.onSessionEnd(this.sessionId);
    }
    // ---------------------------------------------------------------------------
    // Main encode loop
    // ---------------------------------------------------------------------------
    async run() {
        const encoder = this.wasm.createEncoder({
            format: this.opts.format,
            width: this.opts.width,
            height: this.opts.height,
            hasAlpha: this.opts.hasAlpha,
            iccProfile: this.opts.iccProfile,
            exif: this.opts.exif,
            xmp: this.opts.xmp,
            distance: this.opts.distance,
            quality: this.opts.quality,
            effort: this.opts.effort,
            progressive: this.opts.progressive,
            previewFirst: this.opts.previewFirst,
            chunked: this.opts.chunked,
        });
        this.state = "configured";
        try {
            await Promise.all([this.feedEncoder(encoder), this.readEncoderChunks(encoder)]);
        }
        finally {
            await encoder.dispose();
        }
    }
    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------
    waitForPixels() {
        return new Promise((resolve) => {
            const check = () => {
                if (this.pixelQueue.length > 0 || this.finished || this.cancelled) {
                    resolve();
                }
                else if (this.state === "done" || this.state === "error") {
                    resolve();
                }
                else {
                    setTimeout(check, 2);
                }
            };
            check();
        });
    }
    async feedEncoder(encoder) {
        while (!this.cancelled && this.state !== "done" && this.state !== "error") {
            await this.waitForPixels();
            while (this.pixelQueue.length > 0) {
                const entry = this.pixelQueue.shift();
                if (entry === undefined)
                    break;
                this.queueDepth--;
                await encoder.pushPixels(entry.chunk, entry.region);
                if (this.queueDepth < CHUNK_HWM) {
                    self.postMessage({ type: "worker_drain", sessionId: this.sessionId });
                }
            }
            if (this.finished) {
                this.state = "finalising";
                await encoder.finish();
                return;
            }
        }
    }
    async readEncoderChunks(encoder) {
        let totalBytes = 0;
        for await (const chunk of encoder.chunks()) {
            if (this.cancelled || this.state === "done" || this.state === "error")
                return;
            const buffer = toArrayBuffer(chunk);
            if (!this.firstByteEmitted) {
                this.firstByteEmitted = true;
                const firstByteMsg = {
                    type: "encode_first_byte_ready",
                    sessionId: this.sessionId,
                };
                self.postMessage(firstByteMsg);
            }
            totalBytes += buffer.byteLength;
            const msg = {
                type: "encode_chunk",
                sessionId: this.sessionId,
                chunk: buffer,
            };
            this.state = "streaming";
            self.postMessage(msg, [buffer]);
        }
        if (this.cancelled || this.state === "done" || this.state === "error")
            return;
        this.state = "done";
        const doneMsg = {
            type: "encode_done",
            sessionId: this.sessionId,
            totalBytes,
        };
        self.postMessage(doneMsg);
        this.callbacks.onSessionEnd(this.sessionId);
    }
    failSession(code, message) {
        if (this.cancelled || this.state === "done")
            return;
        this.state = "error";
        const msg = {
            type: "encode_error",
            sessionId: this.sessionId,
            code,
            message,
        };
        self.postMessage(msg);
        this.callbacks.onSessionEnd(this.sessionId);
    }
}
function toArrayBuffer(value) {
    if (value instanceof ArrayBuffer)
        return value;
    return value.byteOffset === 0 && value.byteLength === value.buffer.byteLength
        ? value.buffer
        : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
}
//# sourceMappingURL=encode-handler.js.map