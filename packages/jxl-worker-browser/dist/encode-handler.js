// jxl-worker-browser/src/encode-handler.ts
// Encode session handler. Owns one libjxl encoder instance per session.
// Spec: Sections 11, 16.2.
//
// Drives the WASM codec facade; generated libjxl adapter lands with T-WASM-BUILD.
const CHUNK_HWM = 4;
const DRAIN_MIN_INTERVAL_MS = 8;
const FINISH_TIMEOUT_MS = 30_000;
const MAX_QUEUED_BYTES = 128 * 1024 * 1024;
export class EncodeHandler {
    sessionId;
    opts;
    wasm;
    callbacks;
    state = "created";
    pixelQueue = [];
    pixelReadIndex = 0;
    queueDepth = 0;
    queuedBytes = 0;
    cancelled = false;
    finished = false;
    sessionEnded = false;
    firstByteEmitted = false;
    wakeResolve = null;
    lastDrainPostedMs = 0;
    lastDrainAllowed = false;
    encoder = null;
    disposePromise = null;
    // Pre-allocated message objects — mutated in-place before postMessage (safe: structured clone is synchronous).
    _drainMsg = {
        type: "worker_drain",
        sessionId: "",
        latencyMs: 0,
        queueDepth: 0,
        queuedBytes: 0,
        adaptiveHwm: CHUNK_HWM,
    };
    _chunkMsg = {
        type: "encode_chunk",
        sessionId: "",
        chunk: new ArrayBuffer(0),
    };
    constructor(opts, wasm, callbacks) {
        this.sessionId = opts.sessionId;
        this.opts = opts;
        this.wasm = wasm;
        this.callbacks = callbacks;
        this._drainMsg.sessionId = this.sessionId;
        this._chunkMsg.sessionId = this.sessionId;
        this.run().catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            this.failSession("Internal", message);
        });
    }
    // ---------------------------------------------------------------------------
    // Incoming message handlers
    // ---------------------------------------------------------------------------
    onPixels(chunk, region) {
        if (this.isTerminal() || this.finished)
            return;
        if (this.queuedBytes + chunk.byteLength > MAX_QUEUED_BYTES) {
            this.failSession("QueueOverflow", `Encode input queue exceeded ${MAX_QUEUED_BYTES >> 20} MiB`);
            return;
        }
        const entry = region !== undefined ? { chunk, region } : { chunk };
        this.pixelQueue.push(entry);
        this.queueDepth++;
        this.queuedBytes += chunk.byteLength;
        this.wake();
    }
    onFinish() {
        if (this.isTerminal() || this.finished)
            return;
        this.finished = true;
        this.wake();
    }
    async onCancel(reason) {
        if (this.sessionEnded || this.cancelled)
            return;
        this.cancelled = true;
        if (reason !== "release_state") {
            const msg = {
                type: "encode_cancelled",
                sessionId: this.sessionId,
            };
            self.postMessage(msg);
        }
        this.finishSession("cancelled");
        void this.disposeActiveEncoder(reason, true);
    }
    // ---------------------------------------------------------------------------
    // Main encode loop
    // ---------------------------------------------------------------------------
    async run() {
        // Cast to unknown first to allow passing progressiveFlavor which is not yet
        // declared in the JxlModule.createEncoder interface in wasm-loader.ts.
        const encoderOpts = {
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
            // progressiveFlavor is present in protocol.ts but missing from the stale
            // node_modules copy of jxl-core — cast to access it safely.
            progressiveFlavor: this.opts.progressiveFlavor,
            previewFirst: this.opts.previewFirst,
            // progressiveDc + groupOrder (predator progressive layers + Tauri parity): forwarded so high-level session.encode
            // can produce files with >1 DC layer and center-out for the gallery/paint benchmarks and Tauri parity.
            progressiveDc: this.opts.progressiveDc,
            progressiveAc: this.opts.progressiveAc,
            qProgressiveAc: this.opts.qProgressiveAc,
            groupOrder: this.opts.groupOrder,
            chunked: this.opts.chunked,
            sidecarSizes: this.opts.sidecarSizes,
            // EXIF orientation (1..8). When set, JXL records rotation as metadata instead of rotating pixels.
            orientation: this.opts.orientation,
            centerX: this.opts.centerX,
            centerY: this.opts.centerY,
            intrinsicSize: this.opts.intrinsicSize,
            disablePerceptualHeuristics: this.opts.disablePerceptualHeuristics,
            codestreamLevel: this.opts.codestreamLevel,
            copyInput: false,
        };
        const encoder = this.wasm.createEncoder(encoderOpts);
        this.encoder = encoder;
        this.state = "configured";
        try {
            await Promise.all([this.feedEncoder(encoder), this.readEncoderChunks(encoder)]);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.failSession("Internal", message);
        }
        finally {
            await this.disposeActiveEncoder();
            this.finishSession(this.state);
        }
    }
    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------
    finishSession(state) {
        if (this.sessionEnded)
            return false;
        this.state = state;
        this.sessionEnded = true;
        this.clearPixelQueue();
        this.wake();
        this.callbacks.onSessionEnd(this.sessionId);
        return true;
    }
    isTerminal() {
        return this.sessionEnded;
    }
    clearPixelQueue() {
        this.pixelQueue.length = 0;
        this.pixelReadIndex = 0;
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
    disposeActiveEncoder(reason, cancelFirst = false) {
        if (this.disposePromise !== null)
            return this.disposePromise;
        const encoder = this.encoder;
        if (encoder === null)
            return Promise.resolve();
        this.encoder = null;
        this.disposePromise = (async () => {
            if (cancelFirst) {
                try {
                    await encoder.cancel(reason);
                }
                catch (e) {
                    console.error("[jxl-worker] encoder.cancel failed:", e);
                }
            }
            try {
                await encoder.dispose();
            }
            catch (e) {
                console.error("[jxl-worker] encoder.dispose failed:", e);
            }
        })();
        return this.disposePromise;
    }
    waitForPixels() {
        if (this.pixelQueue.length > this.pixelReadIndex || this.finished || this.isTerminal()) {
            return Promise.resolve();
        }
        return new Promise((resolve) => { this.wakeResolve = resolve; });
    }
    takeNextPixels() {
        const entry = this.pixelQueue[this.pixelReadIndex];
        this.pixelQueue[this.pixelReadIndex++] = undefined;
        if (entry === undefined) {
            this.compactQueue();
            return null;
        }
        this.queueDepth--;
        this.queuedBytes -= entry.chunk.byteLength;
        this.compactQueue();
        return entry;
    }
    compactQueue() {
        if (this.pixelReadIndex >= this.pixelQueue.length) {
            this.pixelQueue.length = 0;
            this.pixelReadIndex = 0;
        }
        else if (this.pixelReadIndex > 64 && this.pixelReadIndex * 2 > this.pixelQueue.length) {
            this.pixelQueue.copyWithin(0, this.pixelReadIndex);
            this.pixelQueue.length -= this.pixelReadIndex;
            this.pixelReadIndex = 0;
        }
    }
    async feedEncoder(encoder) {
        while (!this.isTerminal()) {
            await this.waitForPixels();
            while (this.pixelQueue.length > this.pixelReadIndex) {
                const entry = this.takeNextPixels();
                if (entry === null)
                    break;
                await encoder.pushPixels(entry.chunk, entry.region);
                // Re-check state after async pushPixels — cancellation or error may have arrived.
                // Cast through string to defeat TypeScript's pre-await control-flow narrowing.
                if (this.isTerminal())
                    return;
                this.maybePostDrain();
            }
            if (this.finished) {
                // Re-check state before calling finish — guard against race with onCancel.
                if (this.isTerminal())
                    return;
                this.state = "finalising";
                await Promise.race([
                    encoder.finish(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("encoder.finish() timed out after 30 s")), FINISH_TIMEOUT_MS)),
                ]);
                return;
            }
        }
    }
    maybePostDrain() {
        const now = performance.now();
        const drainAllowed = this.queueDepth < CHUNK_HWM;
        const crossedIntoDrain = drainAllowed && !this.lastDrainAllowed;
        const intervalElapsed = now - this.lastDrainPostedMs >= DRAIN_MIN_INTERVAL_MS;
        this.lastDrainAllowed = drainAllowed;
        if (!drainAllowed)
            return;
        if (!crossedIntoDrain && !intervalElapsed)
            return;
        this.lastDrainPostedMs = now;
        this._drainMsg.queueDepth = this.queueDepth;
        this._drainMsg.queuedBytes = this.queuedBytes;
        self.postMessage(this._drainMsg);
    }
    async readEncoderChunks(encoder) {
        let totalBytes = 0;
        const sidecarCount = this.opts.sidecarSizes?.length ?? 0;
        const sidecarOffsets = [];
        let chunkIndex = 0;
        for await (const chunk of encoder.chunks()) {
            if (this.isTerminal())
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
            // Track cumulative byte position at each sidecar boundary.
            // Sidecar chunks are yielded first (one per sidecar), before the main image.
            if (chunkIndex < sidecarCount) {
                sidecarOffsets.push(totalBytes);
            }
            chunkIndex++;
            this._chunkMsg.chunk = buffer;
            this.state = "streaming";
            self.postMessage(this._chunkMsg, [buffer]);
        }
        if (this.isTerminal())
            return;
        this.state = "done";
        const doneMsg = {
            type: "encode_done",
            sessionId: this.sessionId,
            totalBytes,
            ...(sidecarOffsets.length > 0 ? { sidecarOffsets } : {}),
        };
        self.postMessage(doneMsg);
        this.finishSession("done");
    }
    failSession(code, message) {
        if (this.isTerminal())
            return;
        const msg = {
            type: "encode_error",
            sessionId: this.sessionId,
            code,
            message,
        };
        self.postMessage(msg);
        this.finishSession("error");
        void this.disposeActiveEncoder();
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