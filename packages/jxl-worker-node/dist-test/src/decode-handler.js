// jxl-worker-node/src/decode-handler.ts
// Decode session handler for node:worker_threads.
// Same protocol as jxl-worker-browser/decode-handler.ts.
// Drives the selected native/WASM backend facade.
// Adaptive drain HWM: EMA of decoder.push() latency scales the drain threshold.
// Mirrors the browser decode-handler's coalescing strategy exactly.
// Adaptive drain is meaningful for streaming backends (WASM); the batch native
// backend decodes inside close(), so these gates (HWM, EMA, BYTE_DRAIN_HWM) are
// inert there — push() is ~0 ms memcpy and full decode happens before any events flow.
const HWM_BASE = 6;
const HWM_EMA_ALPHA = 0.25;
const MAX_QUEUED_BYTES = 128 * 1024 * 1024; // 128 MiB safety cap — see browser handler
const DRAIN_MIN_INTERVAL_MS = 8;
const BYTE_DRAIN_HWM = 2 * 1024 * 1024; // 2 MiB — byte-level secondary drain gate
export class DecodeHandler {
    sessionId;
    opts;
    backend;
    port;
    callbacks;
    state = "created";
    chunkQueue = [];
    chunkReadIndex = 0;
    queueDepth = 0;
    queuedBytes = 0;
    cancelled = false;
    ended = false;
    inputClosed = false;
    paused = false;
    stageStartMs = performance.now();
    firstPixelMetricPosted = false;
    decoder = null;
    disposePromise = null;
    // Wake/resume coordination — avoids polling; mirrors browser handler.
    wakeResolve = null;
    resumeResolve = null;
    // Drain coalescing state — mirrors browser decode-handler exactly.
    lastDrainPostedMs = 0;
    lastDrainAllowed = false;
    pushLatencyEma = 0;
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
        if (this.isTerminal() || this.inputClosed)
            return;
        if (chunk.byteLength === 0)
            return;
        if (this.queuedBytes + chunk.byteLength > MAX_QUEUED_BYTES) {
            this.failSession("QueueOverflow", `Input queue exceeded ${MAX_QUEUED_BYTES >> 20} MiB`);
            return;
        }
        const isAB = chunk instanceof ArrayBuffer;
        const buf = Buffer.from(isAB ? chunk : chunk.buffer, isAB ? 0 : chunk.byteOffset, isAB ? chunk.byteLength : chunk.byteLength);
        this.chunkQueue.push(buf);
        this.queuedBytes += chunk.byteLength;
        this.queueDepth++;
        this.wake();
    }
    onClose() {
        if (this.isTerminal() || this.inputClosed)
            return;
        this.inputClosed = true;
        this.wake();
    }
    async onCancel(reason) {
        if (this.ended || this.cancelled)
            return;
        this.cancelled = true;
        this.paused = false;
        if (reason !== "release_state") {
            const msg = { type: "decode_cancelled", sessionId: this.sessionId };
            this.port.postMessage(msg);
        }
        this.finishSession("cancelled");
        void this.disposeActiveDecoder();
    }
    onPause() {
        if (this.isTerminal() || this.paused)
            return;
        this.paused = true;
        this.wake(); // wake feedDecoder so it reaches the pause check immediately
        const msg = { type: "decode_paused", sessionId: this.sessionId };
        this.port.postMessage(msg);
    }
    onResume() {
        if (!this.paused)
            return;
        this.paused = false;
        this.wakeResume();
    }
    // ---------------------------------------------------------------------------
    // Terminal-state helpers
    // ---------------------------------------------------------------------------
    isTerminal() {
        return (this.cancelled ||
            this.state === "final" ||
            this.state === "cancelled" ||
            this.state === "error" ||
            this.state === "budget_exceeded");
    }
    // Single path for all session endings. Wakes both sleeping loops so
    // Promise.all resolves promptly and decoder.dispose runs without delay.
    finishSession(state) {
        if (this.ended)
            return false;
        this.ended = true;
        this.state = state;
        this.clearInputQueue();
        this.wake(); // unblock feedDecoder sleeping in waitForChunk
        this.wakeResume(); // unblock feedDecoder sleeping in waitForResume
        this.callbacks.onSessionEnd(this.sessionId);
        return true;
    }
    clearInputQueue() {
        this.chunkQueue.length = 0;
        this.chunkReadIndex = 0;
        this.queueDepth = 0;
        this.queuedBytes = 0;
    }
    wake() {
        const resolve = this.wakeResolve;
        if (resolve !== null) {
            this.wakeResolve = null;
            resolve();
        }
    }
    wakeResume() {
        const resolve = this.resumeResolve;
        if (resolve !== null) {
            this.resumeResolve = null;
            resolve();
        }
    }
    // ---------------------------------------------------------------------------
    // Main decode loop
    // ---------------------------------------------------------------------------
    async run() {
        const codec = this.backend.module;
        const decoder = codec.createDecoder({
            format: this.opts.format,
            region: this.opts.region,
            downsample: this.opts.downsample,
            progressionTarget: this.opts.progressionTarget,
            emitEveryPass: this.opts.emitEveryPass,
            ...(this.opts.progressiveDetail !== null ? { progressiveDetail: this.opts.progressiveDetail } : {}),
            preserveIcc: this.opts.preserveIcc,
            preserveMetadata: this.opts.preserveMetadata,
        });
        this.decoder = decoder;
        try {
            await Promise.all([this.feedDecoder(decoder), this.readDecoderEvents(decoder)]);
        }
        catch (err) {
            if (!this.isTerminal()) {
                this.failSession("Internal", err instanceof Error ? err.message : String(err));
            }
        }
        finally {
            if (!this.ended) {
                this.failSession("Internal", "decoder event stream ended without a terminal event");
            }
            await this.disposeActiveDecoder();
        }
    }
    disposeActiveDecoder() {
        if (this.disposePromise !== null)
            return this.disposePromise;
        const decoder = this.decoder;
        if (decoder === null)
            return Promise.resolve();
        this.decoder = null;
        this.disposePromise = Promise.resolve(decoder.dispose()).catch(() => { });
        return this.disposePromise;
    }
    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------
    waitForChunk() {
        if (this.chunkQueue.length > this.chunkReadIndex || this.inputClosed || this.isTerminal()) {
            return Promise.resolve();
        }
        return new Promise((resolve) => { this.wakeResolve = resolve; });
    }
    waitForResume() {
        if (!this.paused)
            return Promise.resolve();
        return new Promise((resolve) => { this.resumeResolve = resolve; });
    }
    takeNextChunk() {
        const chunk = this.chunkQueue[this.chunkReadIndex];
        this.chunkQueue[this.chunkReadIndex++] = undefined;
        if (chunk === undefined) {
            this.compactQueue();
            return null;
        }
        this.queueDepth--;
        this.queuedBytes -= chunk.byteLength;
        this.compactQueue();
        return chunk;
    }
    compactQueue() {
        if (this.chunkReadIndex >= this.chunkQueue.length) {
            this.chunkQueue.length = 0;
            this.chunkReadIndex = 0;
        }
        else if (this.chunkReadIndex > 64 && this.chunkReadIndex * 2 > this.chunkQueue.length) {
            this.chunkQueue.copyWithin(0, this.chunkReadIndex);
            this.chunkQueue.length -= this.chunkReadIndex;
            this.chunkReadIndex = 0;
        }
    }
    async feedDecoder(decoder) {
        while (!this.isTerminal()) {
            if (this.paused) {
                await this.waitForResume();
                continue;
            }
            await this.waitForChunk();
            if (this.isTerminal() || this.paused)
                continue;
            while (!this.isTerminal() && !this.paused && this.chunkQueue.length > this.chunkReadIndex) {
                const chunk = this.takeNextChunk();
                if (chunk === null)
                    break;
                const t0 = performance.now();
                await decoder.push(chunk);
                const pushMs = performance.now() - t0;
                this.pushLatencyEma = HWM_EMA_ALPHA * pushMs + (1 - HWM_EMA_ALPHA) * this.pushLatencyEma;
                this.maybePostDrain();
            }
            if (this.inputClosed && !this.isTerminal() && !this.paused) {
                await decoder.close();
                return;
            }
        }
    }
    adaptiveHwm() {
        const factor = Math.max(0.6, Math.min(2.0, 120 / (this.pushLatencyEma + 10)));
        return Math.floor(HWM_BASE * factor);
    }
    maybePostDrain() {
        if (this.isTerminal())
            return;
        const now = performance.now();
        const hwm = this.adaptiveHwm();
        const drainAllowed = this.queueDepth < hwm && this.queuedBytes < BYTE_DRAIN_HWM;
        const crossedIntoDrain = drainAllowed && !this.lastDrainAllowed;
        const intervalElapsed = now - this.lastDrainPostedMs >= DRAIN_MIN_INTERVAL_MS;
        this.lastDrainAllowed = drainAllowed;
        if (!drainAllowed)
            return;
        if (!crossedIntoDrain && !intervalElapsed)
            return;
        this.lastDrainPostedMs = now;
        this.port.postMessage({
            type: "worker_drain",
            sessionId: this.sessionId,
            latencyMs: Math.round(this.pushLatencyEma),
            queueDepth: this.queueDepth,
            queuedBytes: this.queuedBytes,
            adaptiveHwm: hwm,
        });
    }
    async readDecoderEvents(decoder) {
        for await (const event of decoder.events()) {
            if (this.isTerminal())
                return;
            switch (event.type) {
                case "header": {
                    this.state = "headers";
                    const msg = { type: "decode_header", sessionId: this.sessionId, info: event.info };
                    this.port.postMessage(msg);
                    this.postMetric("time_to_header_ms", performance.now() - this.stageStartMs);
                    if (this.opts.progressionTarget === "header") {
                        this.finishSession("final");
                        return;
                    }
                    break;
                }
                case "progress": {
                    this.state = "progressive";
                    const pixels = toBuffer(event.pixels);
                    // Budget check BEFORE posting pixels — mirrors browser. postWithPixels
                    // transfers the underlying ArrayBuffer when the Buffer owns it wholly
                    // (native binding case); small views fall back to clone. No reuse after post.
                    if (this.checkBudget()) {
                        this.postBudgetExceeded(event.stage, event.info, pixels, event.format, event.pixelStride);
                        return;
                    }
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
                    this.postWithPixels(msg, pixels);
                    this.postFirstPixelMetric();
                    break;
                }
                case "final": {
                    const pixels = toBuffer(event.pixels);
                    // Budget check BEFORE posting pixels — mirrors browser handler's
                    // "final" budget check (browser decode-handler.ts lines 407-409).
                    if (this.checkBudget()) {
                        this.postBudgetExceeded("final", event.info, pixels, event.format, event.pixelStride);
                        return;
                    }
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
                    this.postWithPixels(msg, pixels);
                    this.postFirstPixelMetric();
                    this.postMetric("time_to_final_ms", performance.now() - this.stageStartMs);
                    this.finishSession("final");
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
        if (this.ended)
            return;
        const msg = { type: "decode_error", sessionId: this.sessionId, code, message };
        this.port.postMessage(msg);
        this.finishSession("error");
        // Best-effort unblock of decoder.events() iterator — mirrors browser handler.
        void this.disposeActiveDecoder();
    }
    checkBudget() {
        if (this.opts.budgetMs == null)
            return false;
        return performance.now() - this.stageStartMs > this.opts.budgetMs;
    }
    postWithPixels(msg, pixels) {
        const ab = pixels.buffer;
        if (pixels.byteOffset === 0 && pixels.byteLength === ab.byteLength) {
            this.port.postMessage(msg, [ab]);
            return;
        }
        const exact = ab.slice(pixels.byteOffset, pixels.byteOffset + pixels.byteLength);
        msg.pixels = exact;
        this.port.postMessage(msg, [exact]);
    }
    postBudgetExceeded(stage, info, pixels, format, pixelStride) {
        if (this.ended)
            return;
        const msg = {
            type: "decode_budget_exceeded",
            sessionId: this.sessionId,
            stage,
            pixels: pixels,
            info,
            format,
            pixelStride,
        };
        this.postWithPixels(msg, pixels);
        this.finishSession("budget_exceeded");
        // Best-effort unblock of decoder.events() iterator — mirrors browser handler.
        void this.disposeActiveDecoder();
    }
    postFirstPixelMetric() {
        if (this.firstPixelMetricPosted)
            return;
        this.firstPixelMetricPosted = true;
        this.postMetric("time_to_first_pixel_ms", performance.now() - this.stageStartMs);
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