// jxl-session/src/decode-session.ts
// DecodeSession implementation. Routes through jxl-scheduler to a worker.
// Spec: Sections 5, 10, 16.1.
import { JxlError } from "@casabio/jxl-core/errors";
import { AsyncEventStream } from "./event-stream.js";
import { deferred, newSessionId, toTransferableBuffer } from "./util.js";
const KNOWN_JXL_ERROR_CODES = new Set([
    "MalformedCodestream", "TruncatedStream", "UnsupportedFeature", "OutOfMemory",
    "BudgetExceeded", "Cancelled", "WorkerCrashed", "CapabilityMissing", "ConfigError",
    "QueueOverflow", "Internal",
]);
export class DecodeSessionImpl {
    id;
    scheduler;
    opts;
    frameStream = new AsyncEventStream();
    doneDeferred = deferred();
    acquirePromise;
    abortSignal;
    abortHandler;
    lastInfo = null;
    closed = false;
    terminated = false;
    framesConsumed = false;
    constructor(scheduler, opts) {
        this.scheduler = scheduler;
        this.opts = opts;
        this.id = newSessionId();
        const startMsg = {
            type: "decode_start",
            sessionId: this.id,
            format: opts.format,
            region: opts.region ?? null,
            downsample: opts.downsample ?? 1,
            progressionTarget: opts.progressionTarget ?? "final",
            emitEveryPass: opts.emitEveryPass ?? true,
            progressiveDetail: opts.progressiveDetail ?? null,
            preserveIcc: opts.preserveIcc ?? true,
            preserveMetadata: opts.preserveMetadata ?? true,
            priority: opts.priority ?? "visible",
            budgetMs: opts.budgetMs ?? null,
            targetWidth: opts.targetWidth ?? null,
            targetHeight: opts.targetHeight ?? null,
            fitMode: opts.fitMode ?? null,
        };
        // A caller may use only frames() and never call done(). Attach a no-op
        // catch so a rejected done() promise with no caller handler does not
        // surface as an unhandledRejection. Callers that do call done() attach
        // their own handler independently.
        void this.doneDeferred.promise.catch(() => undefined);
        // Register the message handler BEFORE acquireSlot sends decode_start,
        // so decode_header is never missed.
        this.scheduler.onMessage(this.id, (msg) => this.handleMessage(msg));
        this.acquirePromise = this.scheduler
            .acquireSlot({
            sessionId: this.id,
            priority: startMsg.priority,
            startMsg,
            sourceKey: opts.sourceKey ?? null,
            signal: opts.signal ?? null,
        })
            .catch((err) => {
            this.fail(new JxlError("Internal", `Failed to acquire worker: ${String(err)}`, { sessionId: this.id, cause: err }));
        });
        // Set up abort signal handling. Check aborted immediately to handle signals
        // that were already triggered before this session was constructed.
        this.abortSignal = opts.signal ?? null;
        if (this.abortSignal !== null) {
            this.abortHandler = () => {
                // Cancel the scheduler slot before failing so the worker is told to stop
                // and the pool slot is released immediately (task 007-concurrency-e7f8a9b0).
                this.scheduler.cancelSession(this.id);
                this.fail(new JxlError("Cancelled", "Decode aborted by signal", { sessionId: this.id }));
            };
            if (this.abortSignal.aborted) {
                this.abortHandler();
            }
            else {
                this.abortSignal.addEventListener("abort", this.abortHandler, { once: true });
            }
        }
        else {
            this.abortHandler = null;
        }
    }
    // ---------------------------------------------------------------------------
    // Public API (DecodeSession)
    // ---------------------------------------------------------------------------
    async push(chunk) {
        if (this.terminated || this.closed) {
            throw new JxlError("ConfigError", "push() after close/cancel/error", { sessionId: this.id });
        }
        await this.acquirePromise;
        // Re-check closed: close() may have set it while we awaited acquirePromise
        // (task 007-concurrency-e5f6a7b8 / 007-errors-f6a7b8c9).
        if (this.terminated || this.closed)
            return;
        // Backpressure: resolves when the worker queue is below the high-water mark.
        await this.scheduler.waitForDrain(this.id);
        // Re-check: cancellation or worker error may have arrived during drain wait.
        if (this.terminated || this.closed)
            return;
        const ab = toTransferableBuffer(chunk);
        this.scheduler.send(this.id, { type: "decode_chunk", sessionId: this.id, chunk: ab }, [ab]);
    }
    async close() {
        if (this.terminated || this.closed)
            return;
        this.closed = true;
        await this.acquirePromise;
        if (this.terminated)
            return;
        this.scheduler.send(this.id, { type: "decode_close", sessionId: this.id });
    }
    frames() {
        this.framesConsumed = true;
        return this.frameStream;
    }
    done() {
        return this.doneDeferred.promise;
    }
    async cancel(reason) {
        // Guard against closed (task 007-logic-a1b2c3d4): cancel after close() but
        // before decode_final must not call fail() and corrupt the completion path.
        // Guard terminated to prevent concurrent callers from racing past the await
        // and invoking cancelSession()+fail() twice (tasks 007-concurrency-c9d0e1f2,
        // 007-errors-c3d4e5f6). JS is single-threaded so both flags are read atomically
        // before the first await point.
        if (this.terminated || this.closed)
            return;
        await this.acquirePromise.catch(() => undefined);
        // Re-check: abort handler or error may have terminated us during the await.
        if (this.terminated)
            return;
        this.scheduler.cancelSession(this.id);
        this.fail(new JxlError("Cancelled", reason ?? "Decode cancelled", { sessionId: this.id }));
    }
    // ---------------------------------------------------------------------------
    // Worker message handling
    // ---------------------------------------------------------------------------
    handleMessage(msg) {
        if (this.terminated)
            return;
        switch (msg.type) {
            case "decode_header":
                if (msg.sessionId !== this.id)
                    return;
                this.lastInfo = msg.info;
                break;
            case "decode_progress": {
                if (msg.sessionId !== this.id)
                    return;
                this.lastInfo = msg.info;
                // Spread region conditionally so the optional property is always
                // present-or-absent at construction time rather than added via post-
                // mutation, keeping all three cases on the same V8 hidden class
                // (task 007-performance-a1b2c3d4). exactOptionalPropertyTypes prevents
                // assigning undefined to the optional field directly.
                const ev = {
                    stage: msg.stage,
                    info: msg.info,
                    pixels: msg.pixels,
                    format: msg.format,
                    pixelStride: msg.pixelStride,
                    ...(msg.region !== undefined ? { region: msg.region } : {}),
                };
                this.frameStream.push(ev);
                break;
            }
            case "decode_final": {
                if (msg.sessionId !== this.id)
                    return;
                this.lastInfo = msg.info;
                const ev = {
                    stage: "final",
                    info: msg.info,
                    pixels: msg.pixels,
                    format: msg.format,
                    pixelStride: msg.pixelStride,
                    ...(msg.region !== undefined ? { region: msg.region } : {}),
                };
                this.frameStream.push(ev);
                this.finish(msg.info);
                break;
            }
            case "decode_budget_exceeded": {
                if (msg.sessionId !== this.id)
                    return;
                this.lastInfo = msg.info;
                const ev = {
                    stage: msg.stage,
                    info: msg.info,
                    pixels: msg.pixels,
                    format: msg.format,
                    pixelStride: msg.pixelStride,
                    ...(msg.region !== undefined ? { region: msg.region } : {}),
                };
                this.frameStream.push(ev);
                this.finishWithError(new JxlError("BudgetExceeded", "Session budget exceeded", {
                    sessionId: this.id,
                    partial: ev,
                }));
                break;
            }
            case "decode_error": {
                if (msg.sessionId !== this.id)
                    return;
                const code = this.normalizeCode(msg.code);
                let partial;
                if (code === "TruncatedStream" && msg.partialPixels !== undefined && msg.partialInfo !== undefined) {
                    // partialPixelStride is required whenever partialPixels is present; a
                    // stride of 0 would produce a malformed frame (task 007-errors-a7b8c9d0).
                    if (msg.partialPixelStride === undefined || msg.partialPixelStride === 0) {
                        this.fail(new JxlError("Internal", "TruncatedStream: worker sent partialPixels without a valid partialPixelStride", { sessionId: this.id }));
                        return;
                    }
                    partial = {
                        stage: msg.partialStage ?? "pass",
                        info: msg.partialInfo,
                        pixels: msg.partialPixels,
                        format: this.opts.format,
                        pixelStride: msg.partialPixelStride,
                    };
                }
                // Truncate worker-supplied message to prevent unbounded strings in
                // error objects (task 007-security-i9j0k1l2).
                const safeMessage = String(msg.message).slice(0, 512);
                const err = new JxlError(code, safeMessage, {
                    sessionId: this.id,
                    ...(partial !== undefined ? { partial } : {}),
                });
                this.fail(err);
                break;
            }
            case "decode_cancelled":
                if (msg.sessionId !== this.id)
                    return;
                this.fail(new JxlError("Cancelled", "Decode cancelled by worker", { sessionId: this.id }));
                break;
            case "metric":
                if (msg.sessionId === this.id && this.opts.onMetric !== undefined) {
                    this.opts.onMetric(msg.metric);
                }
                break;
            default:
                // Unrecognized message type — log in dev mode so missing handlers are
                // caught early when the protocol gains new message types
                // (task 007-contracts-0b1c2d).
                if (typeof process !== "undefined" && process.env?.["NODE_ENV"] === "development") {
                    console.warn(`[jxl-session] decode: unhandled message type '${msg.type}'`);
                }
                break;
        }
    }
    // ---------------------------------------------------------------------------
    // Terminal helpers — all terminal paths funnel through finish() or fail()
    // ---------------------------------------------------------------------------
    cleanup() {
        if (this.abortSignal !== null && this.abortHandler !== null) {
            this.abortSignal.removeEventListener("abort", this.abortHandler);
        }
    }
    finish(info) {
        if (this.terminated)
            return;
        this.terminated = true;
        this.cleanup();
        this.frameStream.end();
        if (!this.doneDeferred.settled) {
            this.doneDeferred.resolve(info);
        }
    }
    // Frame stream ends gracefully (consumers see all buffered frames), but
    // done() rejects. Used for budget_exceeded where the partial frame was
    // already pushed before this is called.
    finishWithError(err) {
        if (this.terminated)
            return;
        this.terminated = true;
        this.cleanup();
        if (this.framesConsumed) {
            // Active consumer: end gracefully so all buffered frames are visible.
            this.frameStream.end();
        }
        else {
            // No consumer ever called frames() — discard the buffered pixel
            // ArrayBuffers immediately rather than retaining them until GC
            // (task 007-concurrency-a7b8c9d0).
            this.frameStream.fail(err);
        }
        if (!this.doneDeferred.settled) {
            this.doneDeferred.reject(err);
        }
    }
    fail(err) {
        if (this.terminated)
            return;
        this.terminated = true;
        this.cleanup();
        this.frameStream.fail(err);
        if (!this.doneDeferred.settled) {
            this.doneDeferred.reject(err);
        }
    }
    normalizeCode(code) {
        return KNOWN_JXL_ERROR_CODES.has(code) ? code : "Internal";
    }
}
//# sourceMappingURL=decode-session.js.map