// jxl-worker-browser/src/decode-handler.ts
// Decode session handler. Owns one libjxl decoder instance per session.
// Spec: Sections 10, 8, 9, 16.1.
//
// Drives the WASM codec facade; generated libjxl adapter lands with T-WASM-BUILD.

/// <reference lib="webworker" />

import type { BrowserDecoder, JxlModule } from "./wasm-loader.js";
import type {
  MsgDecodeStart,
  MsgDecodeHeader,
  MsgDecodeProgress,
  MsgDecodeFinal,
  MsgDecodeError,
  MsgDecodeCancelled,
  MsgDecodePaused,
  MsgDecodeBudgetExceeded,
} from "@casabio/jxl-core/protocol";
import type { ImageInfo, DecodeStage, Region } from "@casabio/jxl-core/types";

type DecodeState =
  | "created"
  | "headers"
  | "progressive"
  | "final"
  | "cancelled"
  | "error"
  | "budget_exceeded";

interface DecodeHandlerCallbacks {
  onSessionEnd: (sessionId: string) => void;
}

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
  private readonly sessionId: string;
  private readonly opts: MsgDecodeStart;
  private readonly wasm: JxlModule;
  private readonly callbacks: DecodeHandlerCallbacks;

  private state: DecodeState = "created";
  private chunkQueue: Array<ArrayBuffer | undefined> = [];
  private chunkReadIndex = 0;
  private queueDepth = 0;
  private queuedBytes = 0;
  private cancelled = false;
  private ended = false;
  private inputClosed = false;
  private wakeResolve: (() => void) | null = null;
  private paused = false;
  private resumeResolve: (() => void) | null = null;
  
  // Active decoder instance; shared disposal promise makes every awaiter join the same operation.
  private decoder: BrowserDecoder | null = null;
  private disposePromise: Promise<void> | null = null;

  // Drain coalescing state.
  private lastDrainPostedMs = 0;
  private lastDrainAllowed = false;

  // Adaptive drain HWM: EMA of decoder.push() duration (ms).
  private pushLatencyEma = 0;
  // Elapsed from session creation; used for both budget and timing metrics.
  private readonly stageStartMs: number = performance.now();

  private firstPixelMetricPosted = false;

  constructor(
    opts: MsgDecodeStart,
    wasm: JxlModule,
    callbacks: DecodeHandlerCallbacks,
  ) {
    this.sessionId = opts.sessionId;
    this.opts = opts;
    this.wasm = wasm;
    this.callbacks = callbacks;

    this.run().catch((err: unknown) => this.failSession("Internal", String(err)));
  }

  // ---------------------------------------------------------------------------
  // Incoming message handlers (called by worker.ts router)
  // ---------------------------------------------------------------------------

  onChunk(chunk: ArrayBuffer): void {
    if (this.isTerminal() || this.inputClosed) return;
    if (chunk.byteLength === 0) return;
    if (this.queuedBytes + chunk.byteLength > MAX_QUEUED_BYTES) {
      this.failSession("QueueOverflow", `Input queue exceeded ${MAX_QUEUED_BYTES >> 20} MiB`);
      return;
    }
    this.chunkQueue.push(chunk);
    this.queuedBytes += chunk.byteLength;
    this.queueDepth++;
    this.wake();
  }

  onClose(): void {
    if (this.isTerminal() || this.inputClosed) return;
    this.inputClosed = true;
    this.wake();
  }

  async onCancel(_reason?: string): Promise<void> {
    if (this.ended || this.cancelled) return;
    this.cancelled = true;
    this.paused = false;
    const msg: MsgDecodeCancelled = {
      type: "decode_cancelled",
      sessionId: this.sessionId,
    };
    self.postMessage(msg);
    this.finishSession("cancelled");

    // Best-effort: dispose the active decoder so any blocked event iterator is unblocked.
    void this.disposeActiveDecoder();
  }

  onPause(): void {
    if (this.isTerminal() || this.paused) return;
    this.paused = true;
    this.wake(); // wake feedDecoder so it reaches the pause check immediately
    const msg: MsgDecodePaused = { type: "decode_paused", sessionId: this.sessionId };
    self.postMessage(msg);
  }

  onResume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.wakeResume();
  }

  // ---------------------------------------------------------------------------
  // Main decode loop
  // ---------------------------------------------------------------------------

  private async run(): Promise<void> {
    const decoder = this.wasm.createDecoder({
      format: this.opts.format,
      region: this.opts.region,
      downsample: this.opts.downsample,
      progressionTarget: this.opts.progressionTarget,
      emitEveryPass: this.opts.emitEveryPass,
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
    } catch (err: unknown) {
      this.failSession("Internal", err instanceof Error ? err.message : String(err));
    } finally {
      // Ensure session finish and best-effort disposal of decoder to unblock
      // any pending async iterators inside the decoder implementation.
      this.finishSession(this.state);
      await this.disposeActiveDecoder();
    }
  }

  // ---------------------------------------------------------------------------
  // Terminal-state helpers
  // ---------------------------------------------------------------------------

  private isTerminal(): boolean {
    return (
      this.cancelled ||
      this.state === "final" ||
      this.state === "cancelled" ||
      this.state === "error" ||
      this.state === "budget_exceeded"
    );
  }

  // Single path for all session endings. Sets state, clears the input queue,
  // and wakes both sleeping loops so Promise.all resolves and decoder.dispose runs.
  private finishSession(state: DecodeState): boolean {
    if (this.ended) return false;
    this.ended = true;
    this.state = state;
    this.clearInputQueue();
    this.wake();       // unblock feedDecoder sleeping in waitForChunk
    this.wakeResume(); // unblock feedDecoder sleeping in waitForResume
    this.callbacks.onSessionEnd(this.sessionId);
    return true;
  }

  private clearInputQueue(): void {
    this.chunkQueue.length = 0;
    this.chunkReadIndex = 0;
    this.queueDepth = 0;
    this.queuedBytes = 0;
  }

  private wake(): void {
    const resolve = this.wakeResolve;
    if (resolve !== null) {
      this.wakeResolve = null;
      resolve();
    }
  }

  private wakeResume(): void {
    const resolve = this.resumeResolve;
    if (resolve !== null) {
      this.resumeResolve = null;
      resolve();
    }
  }

  private disposeActiveDecoder(): Promise<void> {
    if (this.disposePromise !== null) return this.disposePromise;
    const decoder = this.decoder;
    if (decoder === null) return Promise.resolve();
    this.decoder = null;
    this.disposePromise = Promise.resolve(decoder.dispose()).catch(() => {});
    return this.disposePromise;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private waitForChunk(): Promise<void> {
    if (this.chunkQueue.length > this.chunkReadIndex || this.inputClosed || this.isTerminal()) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => { this.wakeResolve = resolve; });
  }

  private waitForResume(): Promise<void> {
    if (!this.paused) return Promise.resolve();
    return new Promise<void>((resolve) => { this.resumeResolve = resolve; });
  }

  private takeNextChunk(): ArrayBuffer | null {
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

  private compactQueue(): void {
    if (this.chunkReadIndex >= this.chunkQueue.length) {
      this.chunkQueue.length = 0;
      this.chunkReadIndex = 0;
    } else if (this.chunkReadIndex > 64 && this.chunkReadIndex * 2 > this.chunkQueue.length) {
      this.chunkQueue.copyWithin(0, this.chunkReadIndex);
      this.chunkQueue.length -= this.chunkReadIndex;
      this.chunkReadIndex = 0;
    }
  }

  private async feedDecoder(decoder: BrowserDecoder): Promise<void> {
    while (!this.isTerminal()) {
      if (this.paused) {
        await this.waitForResume();
        continue;
      }

      await this.waitForChunk();
      if (this.isTerminal() || this.paused) continue;

      while (!this.isTerminal() && this.chunkQueue.length > this.chunkReadIndex) {
        const chunk = this.takeNextChunk();
        if (chunk === null) break;

        const t0 = performance.now();
        await decoder.push(chunk);
        const pushMs = performance.now() - t0;
        this.pushLatencyEma = HWM_EMA_ALPHA * pushMs + (1 - HWM_EMA_ALPHA) * this.pushLatencyEma;

        this.maybePostDrain();
      }

      if (this.inputClosed && !this.isTerminal()) {
        await decoder.close();
        return;
      }
    }
  }

  private maybePostDrain(): void {
    const now = performance.now();
    const hwm = this.adaptiveHwm();

    const drainAllowed = this.queueDepth < hwm && this.queuedBytes < BYTE_DRAIN_HWM;

    const crossedIntoDrain = drainAllowed && !this.lastDrainAllowed;
    const intervalElapsed = now - this.lastDrainPostedMs >= DRAIN_MIN_INTERVAL_MS;

    this.lastDrainAllowed = drainAllowed;

    if (!drainAllowed) return;
    if (!crossedIntoDrain && !intervalElapsed) return;

    this.lastDrainPostedMs = now;

    self.postMessage({
      type: "worker_drain",
      sessionId: this.sessionId,
      latencyMs: Math.round(this.pushLatencyEma),
      queueDepth: this.queueDepth,
      queuedBytes: this.queuedBytes,
      adaptiveHwm: hwm,
    });
  }

  private async readDecoderEvents(decoder: BrowserDecoder): Promise<void> {
    for await (const event of decoder.events()) {
      if (this.isTerminal()) return;
      switch (event.type) {
        case "header": {
          this.state = "headers";
          const msg: MsgDecodeHeader = { type: "decode_header", sessionId: this.sessionId, info: event.info };
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
          const pixels = toArrayBuffer(event.pixels);
          // Budget check BEFORE transferring pixels. postMessage([pixels]) detaches the
          // buffer — reusing it in postBudgetExceeded would send a zero-length payload.
          if (this.checkBudget()) {
            this.postBudgetExceeded(event.stage, event.info, pixels, event.format, event.pixelStride, event.region);
            return;
          }
          const msg: MsgDecodeProgress = {
            type: "decode_progress",
            sessionId: this.sessionId,
            stage: event.stage,
            info: event.info,
            pixels,
            format: event.format,
            pixelStride: event.pixelStride,
          };
          if (event.region !== undefined) msg.region = event.region;
          self.postMessage(msg, [pixels]);
          this.postFirstPixelMetric();
          break;
        }
        case "final": {
          const pixels = toArrayBuffer(event.pixels);
          // Budget check BEFORE transferring pixels — same pattern as "progress".
          // postMessage([pixels]) detaches the buffer; reusing it in postBudgetExceeded
          // would send a zero-length payload.
          if (this.checkBudget()) {
            this.postBudgetExceeded("final", event.info, pixels, event.format, event.pixelStride, event.region);
            return;
          }
          const msg: MsgDecodeFinal = {
            type: "decode_final",
            sessionId: this.sessionId,
            info: event.info,
            pixels,
            format: event.format,
            pixelStride: event.pixelStride,
          };
          if (event.region !== undefined) msg.region = event.region;
          this.postMetric("output_bytes", pixels.byteLength);
          self.postMessage(msg, [pixels]);
          this.postFirstPixelMetric();
          this.postMetric("time_to_final_ms", performance.now() - this.stageStartMs);
          this.finishSession("final");
          return;
        }
        case "budget_exceeded": {
          this.postBudgetExceeded(event.stage, event.info, toArrayBuffer(event.pixels), event.format, event.pixelStride, event.region);
          return;
        }
        case "error": {
          this.failSession(
            event.code,
            event.message,
            event.partialPixels !== undefined ? toArrayBuffer(event.partialPixels) : undefined,
            event.partialInfo,
            event.partialPixelStride,
            event.partialStage,
          );
          return;
        }
      }
    }
  }

  private adaptiveHwm(): number {
    const factor = Math.max(0.6, Math.min(2.0, 120 / (this.pushLatencyEma + 10)));
    return Math.floor(HWM_BASE * factor);
  }

  private checkBudget(): boolean {
    if (this.opts.budgetMs == null) return false;
    return performance.now() - this.stageStartMs > this.opts.budgetMs;
  }

  private failSession(
    code: string,
    message: string,
    partialPixels?: ArrayBuffer,
    partialInfo?: ImageInfo,
    partialPixelStride?: number,
    partialStage?: DecodeStage,
  ): void {
    if (this.ended) return;
    const msg: MsgDecodeError = {
      type: "decode_error",
      sessionId: this.sessionId,
      code,
      message,
    };
    const transfers: ArrayBuffer[] = [];
    if (partialPixels !== undefined && partialInfo !== undefined) {
      msg.partialPixels = partialPixels;
      msg.partialInfo = partialInfo;
      msg.partialPixelStride = partialPixelStride;
      msg.partialStage = partialStage;
      transfers.push(partialPixels);
    }
    self.postMessage(msg, transfers);
    this.finishSession("error");
    // Best-effort unblock of decoder.events().
    void this.disposeActiveDecoder();
  }

  private postBudgetExceeded(
    stage: DecodeStage,
    info: ImageInfo,
    pixels: ArrayBuffer,
    format: MsgDecodeBudgetExceeded["format"],
    pixelStride: number,
    region?: Region,
  ): void {
    if (this.ended) return;
    const msg: MsgDecodeBudgetExceeded = {
      type: "decode_budget_exceeded",
      sessionId: this.sessionId,
      stage,
      pixels,
      info,
      format,
      pixelStride,
    };
    if (region !== undefined) msg.region = region;
    this.postMetric("output_bytes", pixels.byteLength);
    self.postMessage(msg, [pixels]);
    this.finishSession("budget_exceeded");
    // Best-effort unblock of decoder.events().
    void this.disposeActiveDecoder();
  }

  private postFirstPixelMetric(): void {
    if (this.firstPixelMetricPosted) return;
    this.firstPixelMetricPosted = true;
    this.postMetric("time_to_first_pixel_ms", performance.now() - this.stageStartMs);
  }

  private postMetric(name: string, value: number): void {
    self.postMessage({
      type: "metric",
      sessionId: this.sessionId,
      metric: { name, value },
    });
  }
}

function toArrayBuffer(value: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  return value.byteOffset === 0 && value.byteLength === value.buffer.byteLength
    ? value.buffer
    : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
}
