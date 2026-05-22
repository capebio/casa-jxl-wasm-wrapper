// jxl-session/src/encode-session.ts
// EncodeSession implementation. Routes through jxl-scheduler to a worker.
// Spec: Sections 5, 11, 16.2.

import type {
  EncodeOptions,
  EncodeSession,
  Region,
  WorkerToMainMessage,
  MsgEncodeStart,
} from "@casabio/jxl-core";
import { JxlError, type JxlErrorCode } from "@casabio/jxl-core/errors";
import type { Scheduler } from "@casabio/jxl-scheduler";

import { AsyncEventStream } from "./event-stream.js";
import { deferred, newSessionId, toTransferableBuffer, type Deferred } from "./util.js";

export class EncodeSessionImpl implements EncodeSession {
  readonly id: string;

  private readonly scheduler: Scheduler;
  private readonly opts: EncodeOptions;
  private readonly chunkStream = new AsyncEventStream<ArrayBuffer>();
  private readonly doneDeferred: Deferred<number> = deferred<number>();
  private readonly acquirePromise: Promise<unknown>;

  private finished = false;
  private terminated = false;

  constructor(scheduler: Scheduler, opts: EncodeOptions) {
    this.scheduler = scheduler;
    this.opts = opts;
    this.id = newSessionId();

    // Quality/distance: if the caller gave neither, default distance to 1.0.
    const hasDistance = opts.distance !== undefined;
    const hasQuality = opts.quality !== undefined;
    const distance = hasDistance ? opts.distance! : hasQuality ? null : 1.0;
    const quality = hasQuality ? opts.quality! : null;

    const startMsg: MsgEncodeStart = {
      type: "encode_start",
      sessionId: this.id,
      format: opts.format,
      width: opts.width,
      height: opts.height,
      hasAlpha: opts.hasAlpha,
      iccProfile: opts.iccProfile != null ? toTransferableBuffer(opts.iccProfile) : null,
      exif: opts.exif != null ? toTransferableBuffer(opts.exif) : null,
      xmp: opts.xmp != null ? toTransferableBuffer(opts.xmp) : null,
      distance,
      quality,
      effort: opts.effort ?? 4,
      progressive: opts.progressive ?? false,
      previewFirst: opts.previewFirst ?? false,
      chunked: opts.chunked ?? false,
      priority: opts.priority ?? "visible",
    };

    // No-op catch so a rejected done() promise with no caller handler (caller
    // used only chunks()) does not surface as an unhandledRejection.
    void this.doneDeferred.promise.catch(() => undefined);

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

    if (opts.signal != null) {
      opts.signal.addEventListener(
        "abort",
        () => this.terminate(new JxlError("Cancelled", "Encode aborted by signal", { sessionId: this.id })),
        { once: true },
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Public API (EncodeSession)
  // ---------------------------------------------------------------------------

  async pushPixels(chunk: ArrayBuffer, region?: Region): Promise<void> {
    if (this.terminated || this.finished) {
      throw new JxlError("ConfigError", "pushPixels() after finish/cancel/error", { sessionId: this.id });
    }
    await this.acquirePromise;
    if (this.terminated) return;
    await this.scheduler.waitForDrain(this.id);
    const ab = toTransferableBuffer(chunk);
    this.scheduler.send(
      this.id,
      region !== undefined
        ? { type: "encode_pixels", sessionId: this.id, chunk: ab, region }
        : { type: "encode_pixels", sessionId: this.id, chunk: ab },
      [ab],
    );
  }

  async finish(): Promise<void> {
    if (this.terminated || this.finished) return;
    this.finished = true;
    await this.acquirePromise;
    if (this.terminated) return;
    this.scheduler.send(this.id, { type: "encode_finish", sessionId: this.id });
  }

  chunks(): AsyncIterable<ArrayBuffer> {
    return this.chunkStream;
  }

  done(): Promise<number> {
    return this.doneDeferred.promise;
  }

  async cancel(reason?: string): Promise<void> {
    if (this.terminated) return;
    await this.acquirePromise.catch(() => undefined);
    this.scheduler.cancelSession(this.id);
    this.terminate(new JxlError("Cancelled", reason ?? "Encode cancelled", { sessionId: this.id }));
  }

  // ---------------------------------------------------------------------------
  // Worker message handling
  // ---------------------------------------------------------------------------

  private handleMessage(msg: WorkerToMainMessage): void {
    if (this.terminated) return;

    switch (msg.type) {
      case "encode_chunk":
        if (msg.sessionId !== this.id) return;
        this.chunkStream.push(msg.chunk);
        break;

      case "encode_first_byte_ready":
        // Informational only; time_to_first_byte_ms arrives via a metric message.
        break;

      case "encode_done":
        if (msg.sessionId !== this.id) return;
        this.chunkStream.end();
        this.doneDeferred.resolve(msg.totalBytes);
        this.terminated = true;
        break;

      case "encode_error": {
        if (msg.sessionId !== this.id) return;
        this.terminate(new JxlError(this.normalizeCode(msg.code), msg.message, { sessionId: this.id }));
        break;
      }

      case "encode_cancelled":
        if (msg.sessionId !== this.id) return;
        this.terminate(new JxlError("Cancelled", "Encode cancelled by worker", { sessionId: this.id }));
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

  private terminate(err: JxlError): void {
    if (this.terminated) return;
    this.terminated = true;
    this.chunkStream.fail(err);
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
