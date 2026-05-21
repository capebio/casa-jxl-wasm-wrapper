// jxl-worker-node/src/encode-handler.ts
// Encode session handler for node:worker_threads.
// Drives the selected native/WASM backend facade.
const CHUNK_HWM = 4;
export class EncodeHandler {
    sessionId;
    opts;
    backend;
    port;
    callbacks;
    state = "created";
    pixelQueue = [];
    queueDepth = 0;
    cancelled = false;
    finished = false;
    firstByteEmitted = false;
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
        const msg = { type: "encode_cancelled", sessionId: this.sessionId };
        this.port.postMessage(msg);
        this.callbacks.onSessionEnd(this.sessionId);
    }
    async run() {
        const codec = this.backend.module;
        const encoder = codec.createEncoder({
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
    waitForPixels() {
        return new Promise((resolve) => {
            const check = () => {
                if (this.pixelQueue.length > 0 || this.finished || this.cancelled)
                    resolve();
                else if (this.state === "done" || this.state === "error")
                    resolve();
                else
                    setTimeout(check, 2);
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
                    this.port.postMessage({ type: "worker_drain", sessionId: this.sessionId });
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
            const buffer = toBuffer(chunk);
            if (!this.firstByteEmitted) {
                this.firstByteEmitted = true;
                const msg = {
                    type: "encode_first_byte_ready",
                    sessionId: this.sessionId,
                };
                this.port.postMessage(msg);
            }
            totalBytes += buffer.byteLength;
            const msg = {
                type: "encode_chunk",
                sessionId: this.sessionId,
                chunk: buffer,
            };
            this.state = "streaming";
            this.port.postMessage(msg);
        }
        if (this.cancelled || this.state === "done" || this.state === "error")
            return;
        this.state = "done";
        const doneMsg = {
            type: "encode_done",
            sessionId: this.sessionId,
            totalBytes,
        };
        this.port.postMessage(doneMsg);
        this.callbacks.onSessionEnd(this.sessionId);
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
function toBuffer(value) {
    if (Buffer.isBuffer(value))
        return value;
    if (value instanceof ArrayBuffer)
        return Buffer.from(value);
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}
//# sourceMappingURL=encode-handler.js.map