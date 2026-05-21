// jxl-worker-node/src/decode-handler.ts
// Decode session handler for node:worker_threads.
// Same protocol as jxl-worker-browser/decode-handler.ts.
// Drives the selected native/WASM backend facade.
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
    stageStartMs = performance.now();
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
        const codec = this.backend.module;
        const decoder = codec.createDecoder({
            format: this.opts.format,
            region: this.opts.region,
            downsample: this.opts.downsample,
            progressionTarget: this.opts.progressionTarget,
            emitEveryPass: this.opts.emitEveryPass,
            preserveIcc: this.opts.preserveIcc,
            preserveMetadata: this.opts.preserveMetadata,
        });
        try {
            await Promise.all([this.feedDecoder(decoder), this.readDecoderEvents(decoder)]);
        }
        finally {
            await decoder.dispose();
        }
    }
    waitForChunk() {
        return new Promise((resolve) => {
            const check = () => {
                if (this.chunkQueue.length > 0 || this.inputClosed || this.cancelled) {
                    resolve();
                }
                else if (this.state === "final" || this.state === "error" || this.state === "budget_exceeded") {
                    resolve();
                }
                else {
                    setTimeout(check, 2);
                }
            };
            check();
        });
    }
    async feedDecoder(decoder) {
        while (!this.cancelled && this.state !== "final" && this.state !== "error" && this.state !== "budget_exceeded") {
            await this.waitForChunk();
            while (this.chunkQueue.length > 0) {
                const chunk = this.chunkQueue.shift();
                if (chunk === undefined)
                    break;
                this.queueDepth--;
                await decoder.push(chunk);
                if (this.queueDepth < CHUNK_HWM) {
                    this.port.postMessage({ type: "worker_drain", sessionId: this.sessionId });
                }
            }
            if (this.inputClosed) {
                await decoder.close();
                return;
            }
        }
    }
    async readDecoderEvents(decoder) {
        for await (const event of decoder.events()) {
            if (this.cancelled || this.state === "final" || this.state === "error")
                return;
            switch (event.type) {
                case "header": {
                    this.state = "headers";
                    const msg = { type: "decode_header", sessionId: this.sessionId, info: event.info };
                    this.port.postMessage(msg);
                    this.postMetric("time_to_header_ms", performance.now() - this.stageStartMs);
                    if (this.opts.progressionTarget === "header") {
                        this.state = "final";
                        this.callbacks.onSessionEnd(this.sessionId);
                        return;
                    }
                    break;
                }
                case "progress": {
                    this.state = "progressive";
                    const pixels = toBuffer(event.pixels);
                    const msg = {
                        type: "decode_progress",
                        sessionId: this.sessionId,
                        stage: event.stage,
                        info: event.info,
                        pixels: pixels,
                        format: event.format,
                        pixelStride: event.pixelStride,
                    };
                    if (event.region !== undefined)
                        msg.region = event.region;
                    this.port.postMessage(msg);
                    this.postMetric("time_to_first_pixel_ms", performance.now() - this.stageStartMs);
                    if (this.checkBudget()) {
                        this.postBudgetExceeded(event.stage, event.info, pixels, event.format, event.pixelStride);
                        return;
                    }
                    break;
                }
                case "final": {
                    const pixels = toBuffer(event.pixels);
                    const msg = {
                        type: "decode_final",
                        sessionId: this.sessionId,
                        info: event.info,
                        pixels: pixels,
                        format: event.format,
                        pixelStride: event.pixelStride,
                    };
                    if (event.region !== undefined)
                        msg.region = event.region;
                    this.state = "final";
                    this.port.postMessage(msg);
                    this.postMetric("time_to_final_ms", performance.now() - this.stageStartMs);
                    this.callbacks.onSessionEnd(this.sessionId);
                    return;
                }
                case "budget_exceeded": {
                    this.postBudgetExceeded(event.stage, event.info, toBuffer(event.pixels), event.format, event.pixelStride);
                    return;
                }
                case "error": {
                    this.failSession(event.code, event.message);
                    return;
                }
            }
        }
    }
    failSession(code, message) {
        if (this.cancelled || this.state === "final")
            return;
        this.state = "error";
        const msg = { type: "decode_error", sessionId: this.sessionId, code, message };
        this.port.postMessage(msg);
        this.callbacks.onSessionEnd(this.sessionId);
    }
    checkBudget() {
        if (this.opts.budgetMs === null)
            return false;
        return performance.now() - this.stageStartMs > this.opts.budgetMs;
    }
    postBudgetExceeded(stage, info, pixels, format, pixelStride) {
        if (this.cancelled || this.state === "final")
            return;
        this.state = "budget_exceeded";
        const msg = {
            type: "decode_budget_exceeded",
            sessionId: this.sessionId,
            stage,
            pixels: pixels,
            info,
            format,
            pixelStride,
        };
        this.port.postMessage(msg);
        this.callbacks.onSessionEnd(this.sessionId);
    }
    postMetric(name, value) {
        this.port.postMessage({
            type: "metric",
            sessionId: this.sessionId,
            metric: { name, value },
        });
    }
}
function toBuffer(value) {
    if (Buffer.isBuffer(value))
        return value;
    if (value instanceof ArrayBuffer)
        return Buffer.from(value);
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}
//# sourceMappingURL=decode-handler.js.map