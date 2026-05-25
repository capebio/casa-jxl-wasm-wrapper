// jxl-session/src/decode-session.ts
// DecodeSession implementation. Routes through jxl-scheduler to a worker.
// Spec: Sections 5, 10, 16.1.

import type {
  DecodeOptions,
  DecodeSession,
  DecodeFrameEvent,
  ImageInfo,
  WorkerToMainMessage,
  MsgDecodeStart,
} from "@casabio/jxl-core";
import { JxlError, type JxlErrorCode } from "@casabio/jxl-core/errors";
import type { Scheduler } from "@casabio/jxl-scheduler";

import { AsyncEventStream } from "./event-stream.js";
import { deferred, newSessionId, toTransferableBuffer, type Deferred } from "./util.js";

const KNOWN_JXL_ERROR_CODES: ReadonlySet<string> = new Set([
  "MalformedCodestream", "TruncatedStream", "UnsupportedFeature", "OutOfMemory",
  "BudgetExceeded", "Cancelled", "WorkerCrashed", "CapabilityMissing", "ConfigError", "Internal",
]);

export class DecodeSessionImpl implements DecodeSession {
  readonly id: string;

  private readonly scheduler: Scheduler;
  private readonly opts: DecodeOptions;
  private readonly frameStream = new AsyncEventStream<DecodeFrameEvent>();
  private readonly doneDeferred: Deferred<ImageInfo> = deferred<ImageInfo>();
  private readonly acquirePromise: Promise<unknown>;

  private readonly abortSignal: AbortSignal | null;
  private readonly abortHandler: (() => void) | null;

  private lastInfo: ImageInfo | null = null;
  private closed = false;
  private terminated = false;

  constructor(scheduler: Scheduler, opts: DecodeOptions) {
    this.scheduler = scheduler;
    this.opts = opts;
    this.id = newSessionId();

    const startMsg: MsgDecodeStart = {
      type: "decode_start",
      sessionId: this.id,
      format: opts.format,
      region: opts.region ?? null,
      downsample: opts.downsample ?? 1,
      progressionTarget: opts.progressionTarget ?? "final",
      emitEveryPass: opts.emitEveryPass ?? true,
      preserveIcc: opts.preserveIcc ?? true,
      preserveMetadata: opts.preserveMetadata ?? true,
      priority: opts.priority ?? "visible",
      budgetMs: opts.budgetMs ?? null,
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
        sourceKey: null,
        signal: opts.signal ?? null,
      })
      .catch((err: unknown) => {
        this.fail(new JxlError("Internal", `Failed to acquire worker: ${String(err)}`, { sessionId: this.id, cause: err }));
      });

    // Set up abort signal handling. Check aborted immediately to handle signals
    // that were already triggered before this session was constructed.
    this.abortSignal = opts.signal ?? null;
    if (this.abortSignal !== null) {
      this.abortHandler = () => {
        this.fail(new JxlError("Cancelled", "Decode aborted by signal", { sessionId: this.id }));
      };
      if (this.abortSignal.aborted) {
        this.abortHandler();
      } else {
        this.abortSignal.addEventListener("abort", this.abortHandler, { once: true });
      }
    } else {
      this.abortHandler = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Public API (DecodeSession)
  // ---------------------------------------------------------------------------

  async push(chunk: ArrayBuffer | Uint8Array): Promise<void> {
    if (this.terminated || this.closed) {
      throw new JxlError("ConfigError", "push() after close/cancel/error", { sessionId: this.id });
    }
    await this.acquirePromise;
    if (this.terminated) return;
    // Backpressure: resolves when the worker queue is below the high-water mark.
    await this.scheduler.waitForDrain(this.id);
    // Re-check: cancellation or worker error may have arrived during drain wait.
    if (this.terminated || this.closed) return;
    const ab = toTransferableBuffer(chunk);
    this.scheduler.send(this.id, { type: "decode_chunk", sessionId: this.id, chunk: ab }, [ab]);
  }

  async close(): Promise<void> {
    if (this.terminated || this.closed) return;
    this.closed = true;
    await this.acquirePromise;
    if (this.terminated) return;
    this.scheduler.send(this.id, { type: "decode_close", sessionId: this.id });
  }

  frames(): AsyncIterable<DecodeFrameEvent> {
    return this.frameStream;
  }

  done(): Promise<ImageInfo> {
    return this.doneDeferred.promise;
  }

  async cancel(reason?: string): Promise<void> {
    if (this.terminated) return;
    await this.acquirePromise.catch(() => undefined);
    this.scheduler.cancelSession(this.id);
    this.fail(new JxlError("Cancelled", reason ?? "Decode cancelled", { sessionId: this.id }));
  }

  // ---------------------------------------------------------------------------
  // Worker message handling
  // ---------------------------------------------------------------------------

  private handleMessage(msg: WorkerToMainMessage): void {
    if (this.terminated) return;

    switch (msg.type) {
      case "decode_header":
        if (msg.sessionId !== this.id) return;
        this.lastInfo = msg.info;
        break;

      case "decode_progress": {
        if (msg.sessionId !== this.id) return;
        this.lastInfo = msg.info;
        const ev: DecodeFrameEvent = {
          stage: msg.stage,
          info: msg.info,
          pixels: msg.pixels,
          format: msg.format,
          pixelStride: msg.pixelStride,
        };
        if (msg.region !== undefined) ev.region = msg.region;
        this.frameStream.push(ev);
        break;
      }

      case "decode_final": {
        if (msg.sessionId !== this.id) return;
        this.lastInfo = msg.info;
        const ev: DecodeFrameEvent = {
          stage: "final",
          info: msg.info,
          pixels: msg.pixels,
          format: msg.format,
          pixelStride: msg.pixelStride,
        };
        if (msg.region !== undefined) ev.region = msg.region;
        this.frameStream.push(ev);
        this.finish(msg.info);
        break;
      }

      case "decode_budget_exceeded": {
        if (msg.sessionId !== this.id) return;
        this.lastInfo = msg.info;
        const ev: DecodeFrameEvent = {
          stage: msg.stage,
          info: msg.info,
          pixels: msg.pixels,
          format: msg.format,
          pixelStride: msg.pixelStride,
        };
        this.frameStream.push(ev);
        this.finishWithError(
          new JxlError("BudgetExceeded", "Per-stage budget exceeded", {
            sessionId: this.id,
            partial: ev,
          }),
        );
        break;
      }

      case "decode_error": {
        if (msg.sessionId !== this.id) return;
        const code = this.normalizeCode(msg.code);
        let partial: DecodeFrameEvent | undefined;
        if (code === "TruncatedStream" && msg.partialPixels !== undefined && msg.partialInfo !== undefined) {
          partial = {
            stage: "pass",
            info: msg.partialInfo,
            pixels: msg.partialPixels,
            format: this.opts.format,
            pixelStride: 0,
          };
        }
        const err = new JxlError(code, msg.message, {
          sessionId: this.id,
          ...(partial !== undefined ? { partial } : {}),
        });
        this.fail(err);
        break;
      }

      case "decode_cancelled":
        if (msg.sessionId !== this.id) return;
        this.fail(new JxlError("Cancelled", "Decode cancelled by worker", { sessionId: this.id }));
        break;

      case "metric":
        if (msg.sessionId === this.id && this.opts.onMetric !== undefined) {
          this.opts.onMetric(msg.metric);
        }
        break;

      default:
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Terminal helpers — all terminal paths funnel through finish() or fail()
  // ---------------------------------------------------------------------------

  private cleanup(): void {
    if (this.abortSignal !== null && this.abortHandler !== null) {
      this.abortSignal.removeEventListener("abort", this.abortHandler);
    }
  }

  private finish(info: ImageInfo): void {
    if (this.terminated) return;
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
  private finishWithError(err: JxlError): void {
    if (this.terminated) return;
    this.terminated = true;
    this.cleanup();
    this.frameStream.end();
    if (!this.doneDeferred.settled) {
      this.doneDeferred.reject(err);
    }
  }

  private fail(err: JxlError): void {
    if (this.terminated) return;
    this.terminated = true;
    this.cleanup();
    this.frameStream.fail(err);
    if (!this.doneDeferred.settled) {
      this.doneDeferred.reject(err);
    }
  }

  private normalizeCode(code: string): JxlErrorCode {
    return KNOWN_JXL_ERROR_CODES.has(code) ? (code as JxlErrorCode) : "Internal";
  }
}
