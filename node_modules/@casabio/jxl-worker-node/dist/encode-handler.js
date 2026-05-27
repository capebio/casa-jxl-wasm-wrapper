// jxl-worker-node/src/encode-handler.ts
// Encode session handler for node:worker_threads.
// Drives the selected native/WASM backend facade.
const CHUNK_HWM = 4;
const CHUNK_MAX_BUFFERED = 32;
const DRAIN_MIN_INTERVAL_MS = 8;
export class EncodeHandler {
    sessionId;
    opts;
    backend;
    port;
    callbacks;
    state = "created";
    pixelQueue = [];
    pixelReadIndex = 0;
    queueDepth = 0;
    cancelled = false;
    finished = false;
    ended = false;
    firstByteEmitted = false;
    wakeResolve = null;
    lastDrainPostedMs = 0;
    lastDrainAllowed = false;
    constructor(opts, backend, callbacks) {
        this.sessionId = opts.sessionId;
        this.opts = opts;
        this.backend = backend;
        this.port = callbacks.port;
        this.callbacks = callbacks;
        this.run().catch((err) => this.failSession("Internal", String(err)));
    }
    onPixels(chunk, region) {
        if (this.finished ||
            this.cancelled ||
            this.state === "done" ||
            this.state === "error" ||
            this.state === "cancelled")
            return;
        if (this.queueDepth >= CHUNK_MAX_BUFFERED) {
            this.failSession("BackpressureOverflow", `Encode input queue exceeded ${CHUNK_MAX_BUFFERED} buffered chunks`);
            return;
        }
        const buf = Buffer.from(chunk instanceof ArrayBuffer ? chunk : chunk.buffer, chunk instanceof ArrayBuffer ? 0 : chunk.byteOffset, chunk instanceof ArrayBuffer ? chunk.byteLength : chunk.byteLength);
        const entry = { chunk: buf };
        if (region !== undefined)
            entry.region = region;
        this.pixelQueue.push(entry);
        this.queueDepth++;
        this.wake();
    }
    onFinish() {
        if (this.finished ||
            this.cancelled ||
            this.state === "done" ||
            this.state === "error" ||
            this.state === "cancelled")
            return;
        this.finished = true;
        this.wake();
    }
    async onCancel(reason) {
        if (this.cancelled || this.state === "done" || this.state === "error")
            return;
        this.cancelled = true;
        this.state = "cancelled";
        this.wake();
        const msg = { type: "encode_cancelled", sessionId: this.sessionId };
        this.port.postMessage(msg);
        this.endSessionOnce();
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
    wake() {
        const resolve = this.wakeResolve;
        if (resolve === null)
            return;
        this.wakeResolve = null;
        resolve();
    }
    endSessionOnce() {
        if (this.ended)
            return;
        this.ended = true;
        this.callbacks.onSessionEnd(this.sessionId);
    }
    waitForPixels() {
        if (this.pixelQueue.length > this.pixelReadIndex || this.finished || this.cancelled
            || this.state === "done" || this.isErrored()) {
            return Promise.resolve();
        }
        return new Promise((resolve) => { this.wakeResolve = resolve; });
    }
    async feedEncoder(encoder) {
        while (!this.cancelled && this.state !== "done" && !this.isErrored()) {
            await this.waitForPixels();
            while (this.pixelQueue.length > this.pixelReadIndex) {
                const entry = this.pixelQueue[this.pixelReadIndex++];
                if (entry === undefined)
                    break;
                if (this.pixelReadIndex > 64 && this.pixelReadIndex * 2 > this.pixelQueue.length) {
                    this.pixelQueue.copyWithin(0, this.pixelReadIndex);
                    this.pixelQueue.length -= this.pixelReadIndex;
                    this.pixelReadIndex = 0;
                }
                this.queueDepth--;
                if (this.cancelled || this.isErrored())
                    return;
                await encoder.pushPixels(entry.chunk, entry.region);
                if (this.cancelled || this.isErrored())
                    return;
                this.maybePostDrain();
            }
            if (this.finished) {
                if (this.cancelled || this.isErrored())
                    return;
                this.state = "finalising";
                await encoder.finish();
                return;
            }
        }
    }
    maybePostDrain() {
        const drainAllowed = this.queueDepth < CHUNK_HWM;
        const crossedIntoDrain = drainAllowed && !this.lastDrainAllowed;
        this.lastDrainAllowed = drainAllowed;
        if (!drainAllowed)
            return;
        const now = performance.now();
        const intervalElapsed = now - this.lastDrainPostedMs >= DRAIN_MIN_INTERVAL_MS;
        if (!crossedIntoDrain && !intervalElapsed)
            return;
        this.lastDrainPostedMs = now;
        this.port.postMessage({ type: "worker_drain", sessionId: this.sessionId });
    }
    isErrored() {
        return this.state === "error";
    }
    async readEncoderChunks(encoder) {
        let totalBytes = 0;
        let chunkIndex = 0;
        const sidecarCount = this.opts.sidecarSizes?.length ?? 0;
        const sidecarOffsets = [];
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
            if (chunkIndex < sidecarCount) {
                sidecarOffsets.push(totalBytes);
            }
            chunkIndex++;
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
            ...(sidecarOffsets.length > 0 ? { sidecarOffsets } : {}),
        };
        this.port.postMessage(doneMsg);
        this.endSessionOnce();
    }
    failSession(code, message) {
        if (this.cancelled || this.state === "done" || this.state === "error")
            return;
        this.state = "error";
        // Unblock feedEncoder if it's sleeping in waitForPixels — mirrors browser handler.
        this.wake();
        const msg = { type: "encode_error", sessionId: this.sessionId, code, message };
        this.port.postMessage(msg);
        this.endSessionOnce();
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