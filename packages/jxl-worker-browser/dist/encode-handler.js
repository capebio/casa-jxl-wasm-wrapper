// jxl-worker-browser/src/encode-handler.ts
// Encode session handler. Owns one libjxl encoder instance per session.
// Spec: Sections 11, 16.2.
//
// BLOCKED on T-WASM-BUILD + T-ENCODE-WASM for real codec calls.
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
        // STUB: call JxlEncoderDestroy in real impl.
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
        // STUB: real implementation provided by T-ENCODE-WASM.
        //
        // Real flow:
        //   1. Create JxlEncoder, configure JxlEncoderFrameSettings from opts.
        //   2. Map quality→distance via JxlEncoderDistanceFromQuality when needed.
        //   3. Attach iccProfile/exif/xmp boxes.
        //   4. For chunked: false — await finish(), then JxlEncoderAddImageFrame.
        //   5. For chunked: true — loop pixel queue, JxlEncoderAddChunkedFrame.
        //   6. Pump output via JxlEncoderSetOutputProcessor; emit encode_chunk.
        //   7. Emit encode_first_byte_ready on first output chunk.
        //   8. On done: emit encode_done with totalBytes.
        await this.waitForPixels();
        if (this.cancelled)
            return;
        this.state = "configured";
        this.failSession("Internal", "[jxl-worker-browser] encode stub: awaiting T-ENCODE-WASM for real codec.");
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
                else {
                    setTimeout(check, 2);
                }
            };
            check();
        });
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
//# sourceMappingURL=encode-handler.js.map