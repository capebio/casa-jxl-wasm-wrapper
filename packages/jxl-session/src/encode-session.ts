// jxl-session/src/encode-session.ts
// EncodeSession implementation. Routes through jxl-scheduler to a worker.
// Spec: Sections 5, 11, 16.2.

import type {
  EncodeOptions,
  EncodeSession,
  EncodeStats,
  Region,
  WorkerToMainMessage,
  MsgEncodeStart,
} from "@casabio/jxl-core";
import { JxlError, type JxlErrorCode } from "@casabio/jxl-core/errors";
import type { Scheduler } from "@casabio/jxl-scheduler";

import { AsyncEventStream } from "./event-stream.js";
import { deferred, newSessionId, toTransferableBuffer, type Deferred } from "./util.js";

const KNOWN_JXL_ERROR_CODES: ReadonlySet<string> = new Set([
  "MalformedCodestream",
  "TruncatedStream",
  "UnsupportedFeature",
  "OutOfMemory",
  "BudgetExceeded",
  "Cancelled",
  "WorkerCrashed",
  "CapabilityMissing",
  "ConfigError",
  "QueueOverflow",  // task 007-contracts-2d3e4f: was missing, decode side already had it
  "Internal",
]);

export class EncodeSessionImpl implements EncodeSession {
  readonly id: string;

  private readonly scheduler: Scheduler;
  private readonly opts: EncodeOptions;
  private readonly chunkStream = new AsyncEventStream<ArrayBuffer>();
  private readonly doneDeferred: Deferred<number> = deferred<number>();
  private readonly acquirePromise: Promise<unknown>;

  private readonly abortSignal: AbortSignal | null;
  private readonly abortHandler: (() => void) | null;

  private finished = false;
  private terminated = false;
  private totalBytesWritten: number | null = null;
  private sidecarOffsets: readonly number[] | undefined = undefined;

  constructor(scheduler: Scheduler, opts: EncodeOptions) {
    this.scheduler = scheduler;
    this.opts = opts;
    this.id = newSessionId();

    // Quality/distance: if the caller gave neither, default distance to 1.0.
    // When both are provided, distance takes precedence and quality is ignored
    // (task 007-logic-k7l8m9n0: make the precedence rule explicit).
    const hasDistance = opts.distance !== undefined;
    const hasQuality = opts.quality !== undefined;
    const distance = hasDistance ? opts.distance! : hasQuality ? null : 1.0;
    const quality = !hasDistance && hasQuality ? opts.quality! : null;

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
    // progressiveDc + groupOrder (predator): assign conditionally to satisfy exactOptionalPropertyTypes in MsgEncodeStart
    // (the ? in protocol + exact mode dislikes explicit undefined in the literal from opts?: )
    if (opts.progressiveDc != null) (startMsg as any).progressiveDc = opts.progressiveDc;
    if (opts.groupOrder != null) (startMsg as any).groupOrder = opts.groupOrder;
    if (opts.sidecarSizes !== undefined) startMsg.sidecarSizes = opts.sidecarSizes;
    if (opts.orientation != null) startMsg.orientation = opts.orientation;

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

    // Set up abort signal handling. Check aborted immediately to handle signals
    // that were already triggered before this session was constructed.
    this.abortSignal = opts.signal ?? null;
    if (this.abortSignal !== null) {
      this.abortHandler = () => {
        // Cancel the scheduler slot before terminating so the worker receives
        // encode_cancel and releases its pool slot immediately
        // (task 007-concurrency-a3b4c5d6).
        this.scheduler.cancelSession(this.id);
        this.terminate(new JxlError("Cancelled", "Encode aborted by signal", { sessionId: this.id }));
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
  // Public API (EncodeSession)
  // ---------------------------------------------------------------------------

  async pushPixels(chunk: ArrayBuffer, region?: Region): Promise<void> {
    if (this.terminated || this.finished) {
      throw new JxlError("ConfigError", "pushPixels() after finish/cancel/error", { sessionId: this.id });
    }
    await this.acquirePromise;
    if (this.terminated || this.finished) return;
    await this.scheduler.waitForDrain(this.id);
    if (this.terminated || this.finished) return;
    const ab = toTransferableBuffer(chunk);
    // Use conditional spread so the object always has the same shape (single
    // hidden class), avoiding a polymorphic scheduler.send() call site
    // (task 007-performance-g3h4i5j6).
    this.scheduler.send(
      this.id,
      {
        type: "encode_pixels",
        sessionId: this.id,
        chunk: ab,
        ...(region !== undefined ? { region } : {}),
      },
      [ab],
    );
  }

  async finish(): Promise<void> {
    if (this.terminated || this.finished) return;
    // Do not set this.finished until after acquirePromise resolves so that a
    // failed acquire doesn't leave the session with finished=true, which would
    // cause subsequent pushPixels() to throw ConfigError rather than a more
    // accurate error (task 007-contracts-5m6n7o).
    await this.acquirePromise;
    if (this.terminated || this.finished) return;
    this.finished = true;
    this.scheduler.send(this.id, { type: "encode_finish", sessionId: this.id });
  }

  chunks(): AsyncIterable<ArrayBuffer> {
    return this.chunkStream;
  }

  done(): Promise<number> {
    return this.doneDeferred.promise;
  }

  getStats(): EncodeStats | null {
    if (this.totalBytesWritten === null) return null;
    const bpp = this.opts.format === "rgba8" ? 4 : this.opts.format === "rgba16" ? 8 : 16;
    const originalBytes = this.opts.width * this.opts.height * bpp;
    const compressedBytes = this.totalBytesWritten;
    return {
      originalBytes,
      compressedBytes,
      ratio: compressedBytes / originalBytes,
      // Include sidecarOffsets when the worker produced them
      // (task 007-contracts-1a2b3c).
      ...(this.sidecarOffsets !== undefined ? { sidecarOffsets: this.sidecarOffsets } : {}),
    };
  }

  async cancel(reason?: string): Promise<void> {
    // Guard finished: cancel() after finish() but before encode_done would
    // discard already-received encode_chunk buffers (task 007-logic-e5f6a7b8).
    if (this.terminated || this.finished) return;
    await this.acquirePromise.catch(() => undefined);
    // Re-check after the await: abort handler or encode completion may have
    // run during the suspend, preventing double-cancel (task 007-errors-d4e5f6a7).
    if (this.terminated || this.finished) return;
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
        if (msg.sessionId !== this.id) return;
        break;

      case "encode_done":
        if (msg.sessionId !== this.id) return;
        // Capture sidecarOffsets before calling complete() so getStats() can
        // return them (task 007-contracts-1a2b3c).
        this.sidecarOffsets = msg.sidecarOffsets;
        this.complete(msg.totalBytes);
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

  // ---------------------------------------------------------------------------
  // Terminal helpers
  // ---------------------------------------------------------------------------

  private cleanup(): void {
    if (this.abortSignal !== null && this.abortHandler !== null) {
      this.abortSignal.removeEventListener("abort", this.abortHandler);
    }
  }

  // Normal completion: chunk stream ends gracefully, done() resolves.
  private complete(totalBytes: number): void {
    if (this.terminated) return;
    this.terminated = true;
    this.totalBytesWritten = totalBytes;
    this.cleanup();
    this.chunkStream.end();
    if (!this.doneDeferred.settled) {
      this.doneDeferred.resolve(totalBytes);
    }
  }

  private terminate(err: JxlError): void {
    if (this.terminated) return;
    this.terminated = true;
    this.cleanup();
    this.chunkStream.fail(err);
    if (!this.doneDeferred.settled) {
      this.doneDeferred.reject(err);
    }
  }

  private normalizeCode(code: string): JxlErrorCode {
    return KNOWN_JXL_ERROR_CODES.has(code) ? (code as JxlErrorCode) : "Internal";
  }
}
