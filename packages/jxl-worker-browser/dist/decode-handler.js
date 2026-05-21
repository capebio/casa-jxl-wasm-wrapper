// jxl-worker-browser/src/decode-handler.ts
// Decode session handler. Owns one libjxl decoder instance per session.
// Spec: Sections 10, 8, 9, 16.1.
//
// Drives the WASM codec facade; generated libjxl adapter lands with T-WASM-BUILD.
// High-water mark for incoming chunk queue depth before signalling drain.
const CHUNK_HWM = 4;
export class DecodeHandler {
    sessionId;
    opts;
    wasm;
    callbacks;
    state = "created";
    chunkQueue = [];
    queueDepth = 0;
    cancelled = false;
    inputClosed = false;
    // Stage budget tracking
    stageStartMs = performance.now();
    currentStage = "header";
    constructor(opts, wasm, callbacks) {
        this.sessionId = opts.sessionId;
        this.opts = opts;
        this.wasm = wasm;
        this.callbacks = callbacks;
        // Start processing asynchronously.
        this.run().catch((err) => this.failSession("Internal", String(err)));
    }
    // ---------------------------------------------------------------------------
    // Incoming message handlers (called by worker.ts router)
    // ---------------------------------------------------------------------------
    onChunk(chunk) {
        if (this.cancelled || this.state === "final")
            return;
        this.chunkQueue.push(chunk);
        this.queueDepth++;
        // Signal backpressure if above HWM.
        if (this.queueDepth >= CHUNK_HWM) {
            // Drain signal will be posted after the handler processes chunks.
        }
    }
    onClose() {
        this.inputClosed = true;
    }
    async onCancel(reason) {
        if (this.cancelled)
            return;
        this.cancelled = true;
        this.state = "cancelled";
        const msg = {
            type: "decode_cancelled",
            sessionId: this.sessionId,
        };
        self.postMessage(msg);
        this.callbacks.onSessionEnd(this.sessionId);
    }
    // ---------------------------------------------------------------------------
    // Main decode loop
    // ---------------------------------------------------------------------------
    async run() {
        const decoder = this.wasm.createDecoder({
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
    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------
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
        while (!this.cancelled && this.state !== "final" && this.state !== "error") {
            await this.waitForChunk();
            while (this.chunkQueue.length > 0) {
                const chunk = this.chunkQueue.shift();
                if (chunk === undefined)
                    break;
                this.queueDepth--;
                await decoder.push(chunk);
                if (this.queueDepth < CHUNK_HWM) {
                    self.postMessage({ type: "worker_drain", sessionId: this.sessionId });
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
                    self.postMessage(msg);
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
                    const pixels = toArrayBuffer(event.pixels);
                    const msg = {
                        type: "decode_progress",
                        sessionId: this.sessionId,
                        stage: event.stage,
                        info: event.info,
                        pixels,
                        format: event.format,
                        pixelStride: event.pixelStride,
                    };
                    if (event.region !== undefined)
                        msg.region = event.region;
                    self.postMessage(msg, [pixels]);
                    this.postMetric("time_to_first_pixel_ms", performance.now() - this.stageStartMs);
                    if (this.checkBudget(event.stage)) {
                        this.postBudgetExceeded(event.stage, event.info, pixels, event.format, event.pixelStride);
                        return;
                    }
                    break;
                }
                case "final": {
                    const pixels = toArrayBuffer(event.pixels);
                    const msg = {
                        type: "decode_final",
                        sessionId: this.sessionId,
                        info: event.info,
                        pixels,
                        format: event.format,
                        pixelStride: event.pixelStride,
                    };
                    if (event.region !== undefined)
                        msg.region = event.region;
                    this.state = "final";
                    self.postMessage(msg, [pixels]);
                    this.postMetric("time_to_final_ms", performance.now() - this.stageStartMs);
                    this.callbacks.onSessionEnd(this.sessionId);
                    return;
                }
                case "budget_exceeded": {
                    this.postBudgetExceeded(event.stage, event.info, toArrayBuffer(event.pixels), event.format, event.pixelStride);
                    return;
                }
                case "error": {
                    this.failSession(event.code, event.message);
                    return;
                }
            }
        }
    }
    checkBudget(stage) {
        if (this.opts.budgetMs === null)
            return false;
        const elapsed = performance.now() - this.stageStartMs;
        return elapsed > this.opts.budgetMs;
    }
    failSession(code, message) {
        if (this.cancelled || this.state === "final")
            return;
        this.state = "error";
        const msg = {
            type: "decode_error",
            sessionId: this.sessionId,
            code,
            message,
        };
        self.postMessage(msg);
        this.callbacks.onSessionEnd(this.sessionId);
    }
    postBudgetExceeded(stage, info, pixels, format, pixelStride) {
        if (this.cancelled || this.state === "final")
            return;
        this.state = "budget_exceeded";
        const msg = {
            type: "decode_budget_exceeded",
            sessionId: this.sessionId,
            stage,
            pixels,
            info,
            format,
            pixelStride,
        };
        self.postMessage(msg, [pixels]);
        this.callbacks.onSessionEnd(this.sessionId);
    }
    postMetric(name, value) {
        self.postMessage({
            type: "metric",
            sessionId: this.sessionId,
            metric: { name, value },
        });
    }
}
function toArrayBuffer(value) {
    if (value instanceof ArrayBuffer)
        return value;
    return value.byteOffset === 0 && value.byteLength === value.buffer.byteLength
        ? value.buffer
        : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
}
//# sourceMappingURL=decode-handler.js.map