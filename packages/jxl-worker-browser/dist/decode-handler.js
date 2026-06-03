// jxl-worker-browser/src/decode-handler.ts
// Decode session handler. Owns one libjxl decoder instance per session.
// Spec: Sections 10, 8, 9, 16.1.
//
// Drives the WASM codec facade; generated libjxl adapter lands with T-WASM-BUILD.
// Adaptive high-water mark: EMA of decoder.push() latency scales the drain threshold.
// Fast workers → higher HWM (buffer more) → fewer drain round-trips.
// Slow workers → lower HWM → earlier drain signal → less queued memory.
const HWM_BASE = 6;
const HWM_EMA_ALPHA = 0.25;
// Safety cap on total queued bytes. Scheduler's adaptive HWM keeps queued bytes well
// below this (~2 MiB) in normal use; cap only fires for scheduler-free or buggy callers.
const MAX_QUEUED_BYTES = 128 * 1024 * 1024; // 128 MiB
const DRAIN_MIN_INTERVAL_MS = 8;
const BYTE_DRAIN_HWM = 2 * 1024 * 1024; // 2 MiB — byte-level secondary drain gate
export class DecodeHandler {
    sessionId;
    opts;
    wasm;
    callbacks;
    state = "created";
    chunkQueue = [];
    chunkReadIndex = 0;
    queueDepth = 0;
    queuedBytes = 0;
    cancelled = false;
    ended = false;
    inputClosed = false;
    wakeResolve = null;
    paused = false;
    resumeResolve = null;
    // Active decoder instance; shared disposal promise makes every awaiter join the same operation.
    decoder = null;
    disposePromise = null;
    // Drain coalescing state.
    lastDrainPostedMs = 0;
    lastDrainAllowed = false;
    // Adaptive drain HWM: EMA of decoder.push() duration (ms).
    pushLatencyEma = 0;
    // Elapsed from session creation; used for both budget and timing metrics.
    stageStartMs = performance.now();
    firstPixelMetricPosted = false;
    // Pre-allocated message objects — avoids per-call allocation in hot paths.
    // postMessage() performs a synchronous structured clone before returning, so mutating these
    // fields after the call is safe (JS worker is single-threaded; no interleaving possible).
    _metricInner = { name: "", value: 0 };
    _metricMsg = {
        type: "metric",
        sessionId: "",
        metric: this._metricInner,
    };
    _drainMsg = {
        type: "worker_drain",
        sessionId: "",
        latencyMs: 0,
        queueDepth: 0,
        queuedBytes: 0,
        adaptiveHwm: 0,
    };
    // Cached adaptiveHwm result; invalidated when EMA drifts by ≥1 ms.
    _cachedHwm = HWM_BASE;
    _hwmLastEma = -1;
    constructor(opts, wasm, callbacks) {
        this.sessionId = opts.sessionId;
        this.opts = opts;
        this.wasm = wasm;
        this.callbacks = callbacks;
        this._metricMsg.sessionId = this.sessionId;
        this._drainMsg.sessionId = this.sessionId;
        this.run().catch((err) => this.failSession("Internal", String(err)));
    }
    // ---------------------------------------------------------------------------
    // Incoming message handlers (called by worker.ts router)
    // ---------------------------------------------------------------------------
    onChunk(chunk) {
        if (this.isTerminal() || this.inputClosed)
            return;
        if (chunk.byteLength === 0)
            return;
        if (this.queuedBytes + chunk.byteLength > MAX_QUEUED_BYTES) {
            this.failSession("QueueOverflow", `Input queue exceeded ${MAX_QUEUED_BYTES >> 20} MiB`);
            return;
        }
        this.chunkQueue.push(chunk);
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
    async onCancel(_reason) {
        if (this.ended || this.cancelled)
            return;
        this.cancelled = true;
        this.paused = false;
        const msg = {
            type: "decode_cancelled",
            sessionId: this.sessionId,
        };
        self.postMessage(msg);
        this.finishSession("cancelled");
        // Best-effort: dispose the active decoder so any blocked event iterator is unblocked.
        void this.disposeActiveDecoder();
    }
    onPause() {
        if (this.isTerminal() || this.paused)
            return;
        this.paused = true;
        this.wake(); // wake feedDecoder so it reaches the pause check immediately
        const msg = { type: "decode_paused", sessionId: this.sessionId };
        self.postMessage(msg);
    }
    onResume() {
        if (!this.paused)
            return;
        this.paused = false;
        this.wakeResume();
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
            ...(this.opts.progressiveDetail !== null ? { progressiveDetail: this.opts.progressiveDetail } : {}),
            preserveIcc: this.opts.preserveIcc,
            preserveMetadata: this.opts.preserveMetadata,
            targetWidth: this.opts.targetWidth,
            targetHeight: this.opts.targetHeight,
            fitMode: this.opts.fitMode,
            onMetric: (name, value) => this.postMetric(name, value),
        });
        // Store decoder reference so terminal paths can actively dispose it.
        this.decoder = decoder;
        try {
            await Promise.all([this.feedDecoder(decoder), this.readDecoderEvents(decoder)]);
        }
        catch (err) {
            this.failSession("Internal", err instanceof Error ? err.message : String(err));
        }
        finally {
            // Ensure session finish and best-effort disposal of decoder to unblock
            // any pending async iterators inside the decoder implementation.
            this.finishSession(this.state);
            await this.disposeActiveDecoder();
        }
    }
    // ---------------------------------------------------------------------------
    // Terminal-state helpers
    // ---------------------------------------------------------------------------
    isTerminal() {
        // finishSession() is the single path that sets ended=true for all terminal
        // states; this.ended is always true when any individual state flag is set.
        return this.ended;
    }
    // Single path for all session endings. Sets state, clears the input queue,
    // and wakes both sleeping loops so Promise.all resolves and decoder.dispose runs.
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
    disposeActiveDecoder() {
        if (this.disposePromise !== null)
            return this.disposePromise;
        const decoder = this.decoder;
        if (decoder === null)
            return Promise.resolve();
        this.decoder = null;
        this.disposePromise = Promise.resolve(decoder.dispose()).catch((e) => {
            console.error('[jxl-worker] disposeActiveDecoder failed:', e);
        });
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
        while (!this.ended) {
            if (this.paused) {
                await this.waitForResume();
                continue;
            }
            // Skip the await when chunks are already queued — avoids a microtask
            // yield on every outer iteration during active streaming.
            if (this.chunkQueue.length <= this.chunkReadIndex && !this.inputClosed) {
                await this.waitForChunk();
                if (this.ended || this.paused)
                    continue;
            }
            while (!this.ended && this.chunkQueue.length > this.chunkReadIndex) {
                const chunk = this.takeNextChunk();
                if (chunk === null)
                    break;
                const t0 = performance.now();
                await decoder.push(chunk);
                // Reuse the post-push timestamp for drain coalescing — avoids a
                // redundant performance.now() call in maybePostDrain.
                const now = performance.now();
                const pushMs = now - t0;
                this.pushLatencyEma = HWM_EMA_ALPHA * pushMs + (1 - HWM_EMA_ALPHA) * this.pushLatencyEma;
                this.maybePostDrain(now);
            }
            if (this.inputClosed && !this.ended) {
                await decoder.close();
                return;
            }
        }
    }
    maybePostDrain(now) {
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
        this._drainMsg.latencyMs = Math.round(this.pushLatencyEma);
        this._drainMsg.queueDepth = this.queueDepth;
        this._drainMsg.queuedBytes = this.queuedBytes;
        this._drainMsg.adaptiveHwm = hwm;
        self.postMessage(this._drainMsg);
    }
    async readDecoderEvents(decoder) {
        for await (const event of decoder.events()) {
            if (this.isTerminal())
                return;
            switch (event.type) {
                case "header": {
                    this.state = "headers";
                    const msg = { type: "decode_header", sessionId: this.sessionId, info: event.info };
                    self.postMessage(msg);
                    this.postMetric("time_to_header_ms", performance.now() - this.stageStartMs);
                    if (this.opts.progressionTarget === "header") {
                        this.finishSession("final");
                        return;
                    }
                    break;
                }
                case "progress": {
                    this.state = "progressive";
                    const t0 = performance.now();
                    const pixels = toArrayBuffer(event.pixels);
                    const tToArray = performance.now() - t0;
                    this.postMetric("decode_toarraybuffer_ms", tToArray);
                    // Budget check BEFORE transferring pixels. postMessage([pixels]) detaches the
                    // buffer — reusing it in postBudgetExceeded would send a zero-length payload.
                    if (this.checkBudget()) {
                        this.postBudgetExceeded(event.stage, event.info, pixels, event.format, event.pixelStride, event.region);
                        return;
                    }
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
                    this.postFirstPixelMetric();
                    break;
                }
                case "final": {
                    const t0 = performance.now();
                    const pixels = toArrayBuffer(event.pixels);
                    const tToArray = performance.now() - t0;
                    this.postMetric("decode_toarraybuffer_ms", tToArray);
                    // Budget check BEFORE transferring pixels — same pattern as "progress".
                    // postMessage([pixels]) detaches the buffer; reusing it in postBudgetExceeded
                    // would send a zero-length payload.
                    if (this.checkBudget()) {
                        this.postBudgetExceeded("final", event.info, pixels, event.format, event.pixelStride, event.region);
                        return;
                    }
                    const now = performance.now();
                    const msg = {
                        type: "decode_final",
                        sessionId: this.sessionId,
                        info: event.info,
                        pixels,
                        format: event.format,
                        pixelStride: event.pixelStride,
                        outputBytes: pixels.byteLength,
                        timeToFinalMs: now - this.stageStartMs,
                    };
                    if (event.region !== undefined)
                        msg.region = event.region;
                    // Embed first-pixel timing if it hasn't been reported via a progress event.
                    if (!this.firstPixelMetricPosted) {
                        msg.timeToFirstPixelMs = now - this.stageStartMs;
                        this.postFirstPixelMetric();
                    }
                    self.postMessage(msg, [pixels]);
                    this.finishSession("final");
                    return;
                }
                case "budget_exceeded": {
                    this.postBudgetExceeded(event.stage, event.info, toArrayBuffer(event.pixels), event.format, event.pixelStride, event.region);
                    return;
                }
                case "error": {
                    this.failSession(event.code, event.message, event.partialPixels !== undefined ? toArrayBuffer(event.partialPixels) : undefined, event.partialInfo, event.partialPixelStride, event.partialStage);
                    return;
                }
            }
        }
    }
    adaptiveHwm() {
        const ema = this.pushLatencyEma;
        if (Math.abs(ema - this._hwmLastEma) < 1.0)
            return this._cachedHwm;
        this._hwmLastEma = ema;
        const factor = Math.max(0.6, Math.min(2.0, 120 / (ema + 10)));
        this._cachedHwm = Math.floor(HWM_BASE * factor);
        return this._cachedHwm;
    }
    checkBudget() {
        if (this.opts.budgetMs == null)
            return false;
        return performance.now() - this.stageStartMs > this.opts.budgetMs;
    }
    failSession(code, message, partialPixels, partialInfo, partialPixelStride, partialStage) {
        if (this.ended)
            return;
        const msg = {
            type: "decode_error",
            sessionId: this.sessionId,
            code,
            message,
        };
        const transfers = [];
        if (partialPixels !== undefined && partialInfo !== undefined) {
            msg.partialPixels = partialPixels;
            msg.partialInfo = partialInfo;
            if (partialPixelStride !== undefined)
                msg.partialPixelStride = partialPixelStride;
            if (partialStage !== undefined)
                msg.partialStage = partialStage;
            transfers.push(partialPixels);
        }
        self.postMessage(msg, transfers);
        this.finishSession("error");
        // Best-effort unblock of decoder.events().
        void this.disposeActiveDecoder();
    }
    postBudgetExceeded(stage, info, pixels, format, pixelStride, region) {
        if (this.ended)
            return;
        const msg = {
            type: "decode_budget_exceeded",
            sessionId: this.sessionId,
            stage,
            pixels,
            info,
            format,
            pixelStride,
        };
        if (region !== undefined)
            msg.region = region;
        this.postMetric("output_bytes", pixels.byteLength);
        self.postMessage(msg, [pixels]);
        this.finishSession("budget_exceeded");
        // Best-effort unblock of decoder.events().
        void this.disposeActiveDecoder();
    }
    postFirstPixelMetric() {
        if (this.firstPixelMetricPosted)
            return;
        this.firstPixelMetricPosted = true;
        this.postMetric("time_to_first_pixel_ms", performance.now() - this.stageStartMs);
    }
    postMetric(name, value) {
        this._metricInner.name = name;
        this._metricInner.value = value;
        self.postMessage(this._metricMsg);
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