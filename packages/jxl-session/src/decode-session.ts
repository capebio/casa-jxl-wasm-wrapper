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

export class DecodeSessionImpl implements DecodeSession {
  readonly id: string;

  private readonly scheduler: Scheduler;
  private readonly opts: DecodeOptions;
  private readonly frameStream = new AsyncEventStream<DecodeFrameEvent>();
  private readonly doneDeferred: Deferred<ImageInfo> = deferred<ImageInfo>();
  private readonly acquirePromise: Promise<unknown>;

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
        this.terminate(new JxlError("Internal", `Failed to acquire worker: ${String(err)}`, { sessionId: this.id, cause: err }));
      });

    // Settle done() on external abort even if the session never reached a worker.
    if (opts.signal != null) {
      opts.signal.addEventListener(
        "abort",
        () => this.terminate(new JxlError("Cancelled", "Decode aborted by signal", { sessionId: this.id })),
        { once: true },
      );
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
    this.terminate(new JxlError("Cancelled", reason ?? "Decode cancelled", { sessionId: this.id }));
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
        this.frameStream.end();
        this.doneDeferred.resolve(msg.info);
        this.terminated = true;
        break;
      }

      case "decode_budget_exceeded": {
        if (msg.sessionId !== this.id) return;
        const ev: DecodeFrameEvent = {
          stage: msg.stage,
          info: msg.info,
          pixels: msg.pixels,
          format: msg.format,
          pixelStride: msg.pixelStride,
        };
        this.frameStream.push(ev);
        this.frameStream.end();
        // done() rejects: budget breach is a terminal non-final stop (Section 10.1).
        this.doneDeferred.reject(
          new JxlError("BudgetExceeded", "Per-stage budget exceeded", {
            sessionId: this.id,
            partial: ev,
          }),
        );
        this.terminated = true;
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
        this.terminate(err);
        break;
      }

      case "decode_cancelled":
        if (msg.sessionId !== this.id) return;
        this.terminate(new JxlError("Cancelled", "Decode cancelled by worker", { sessionId: this.id }));
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

  // Terminate the session with an error: fail streams, reject done() if pending.
  private terminate(err: JxlError): void {
    if (this.terminated) return;
    this.terminated = true;
    this.frameStream.fail(err);
    if (!this.doneDeferred.settled) {
      this.doneDeferred.reject(err);
    }
  }

  private normalizeCode(code: string): JxlErrorCode {
    const known: JxlErrorCode[] = [
      "MalformedCodestream", "TruncatedStream", "UnsupportedFeature", "OutOfMemory",
      "BudgetExceeded", "Cancelled", "WorkerCrashed", "CapabilityMissing", "ConfigError", "Internal",
    ];
    return (known as string[]).includes(code) ? (code as JxlErrorCode) : "Internal";
  }
}
