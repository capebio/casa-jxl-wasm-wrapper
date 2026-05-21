// jxl-worker-browser/src/decode-handler.ts
// Decode session handler. Owns one libjxl decoder instance per session.
// Spec: Sections 10, 8, 9, 16.1.
//
// BLOCKED on T-WASM-BUILD + T-DECODE-WASM for real codec calls.
// This file implements the state machine, message protocol, and lifecycle.
// Codec calls are stubbed and marked for T-DECODE-WASM to fill in.
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
        // STUB: in real impl, call JxlDecoderDestroy here.
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
        // STUB: real implementation provided by T-DECODE-WASM.
        //
        // Real flow:
        //   1. Create JxlDecoder via jxl-wasm.
        //   2. JxlDecoderSubscribeEvents(JXL_DEC_BASIC_INFO | JXL_DEC_COLOR_ENCODING |
        //        JXL_DEC_FRAME | JXL_DEC_FULL_IMAGE | JXL_DEC_FRAME_PROGRESSION)
        //   3. Loop: pull chunks from this.chunkQueue, feed via JxlDecoderSetInput.
        //   4. On JXL_DEC_BASIC_INFO: emit decode_header, transition to "headers".
        //   5. On JXL_DEC_FRAME_PROGRESSION: JxlDecoderFlushImage, transfer buffer,
        //        emit decode_progress, check budget.
        //   6. On JXL_DEC_FULL_IMAGE: emit decode_final, transition to "final".
        //   7. On error: failSession.
        //
        // For now: emit a stub header so callers can observe the protocol shape.
        // Wait briefly for first chunk.
        await this.waitForChunk();
        if (this.cancelled)
            return;
        // Emit stub header
        this.state = "headers";
        const stubInfo = {
            width: 0,
            height: 0,
            bitsPerSample: 8,
            hasAlpha: false,
            hasAnimation: false,
            jpegReconstructionAvailable: false,
        };
        const headerMsg = {
            type: "decode_header",
            sessionId: this.sessionId,
            info: stubInfo,
        };
        self.postMessage(headerMsg);
        if (this.opts.progressionTarget === "header") {
            this.state = "final";
            this.callbacks.onSessionEnd(this.sessionId);
            return;
        }
        // STUB: fail with a clear message so T-DECODE-WASM can take over.
        this.failSession("Internal", "[jxl-worker-browser] decode stub: awaiting T-DECODE-WASM for real codec.");
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
                else {
                    setTimeout(check, 2);
                }
            };
            check();
        });
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
    postMetric(name, value) {
        self.postMessage({
            type: "metric",
            sessionId: this.sessionId,
            metric: { name, value },
        });
    }
}
//# sourceMappingURL=decode-handler.js.map