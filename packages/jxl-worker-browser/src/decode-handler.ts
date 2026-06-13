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
import type { ImageInfo, DecodeStage, PixelFormat, Region } from "@casabio/jxl-core/types";

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

class ChunkRing {
  private items: Array<ArrayBuffer | undefined>;
  private head = 0;
  private tail = 0;
  private length = 0;
  private totalBytes = 0;

  constructor(initialCapacity = 16) {
    this.items = new Array(initialCapacity);
  }

  get size(): number {
    return this.length;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  push(chunk: ArrayBuffer): void {
    if (this.length === this.items.length) this.grow();
    this.items[this.tail] = chunk;
    this.tail = (this.tail + 1) % this.items.length;
    this.length++;
    this.totalBytes += chunk.byteLength;
  }

  shift(): ArrayBuffer | null {
    if (this.length === 0) return null;
    const chunk = this.items[this.head];
    this.items[this.head] = undefined;
    this.head = (this.head + 1) % this.items.length;
    this.length--;
    if (chunk !== undefined) {
      this.totalBytes -= chunk.byteLength;
      return chunk;
    }
    return null;
  }

  clear(): void {
    this.items.fill(undefined);
    this.head = 0;
    this.tail = 0;
    this.length = 0;
    this.totalBytes = 0;
  }

  private grow(): void {
    const next = new Array<ArrayBuffer | undefined>(this.items.length * 2);
    for (let i = 0; i < this.length; i++) {
      next[i] = this.items[(this.head + i) % this.items.length];
    }
    this.items = next;
    this.head = 0;
    this.tail = this.length;
  }
}

export class DecodeHandler {
  private readonly sessionId: string;
  private readonly opts: MsgDecodeStart;
  private readonly wasm: JxlModule;
  private readonly callbacks: DecodeHandlerCallbacks;

  private state: DecodeState = "created";
  private chunkQueue = new ChunkRing();
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
  private copyLatencyEma = 0;
  // Elapsed from session creation; used for both budget and timing metrics.
  private readonly stageStartMs: number = performance.now();

  private firstPixelMetricPosted = false;

  // Pre-allocated message objects — avoids per-call allocation in hot paths.
  // postMessage() performs a synchronous structured clone before returning, so mutating these
  // fields after the call is safe (JS worker is single-threaded; no interleaving possible).
  private readonly _metricInner = { name: "", value: 0 };
  private readonly _metricMsg = {
    type: "metric" as const,
    sessionId: "" as string,
    metric: this._metricInner,
  };
  private readonly _drainMsg = {
    type: "worker_drain" as const,
    sessionId: "" as string,
    latencyMs: 0,
    queueDepth: 0,
    queuedBytes: 0,
    adaptiveHwm: 0,
  };

  // Cached adaptiveHwm result; invalidated when EMA drifts by ≥1 ms.
  private _cachedHwm = HWM_BASE;
  private _hwmLastEma = -1;

  constructor(
    opts: MsgDecodeStart,
    wasm: JxlModule,
    callbacks: DecodeHandlerCallbacks,
  ) {
    this.sessionId = opts.sessionId;
    this.opts = opts;
    this.wasm = wasm;
    this.callbacks = callbacks;

    this._metricMsg.sessionId = this.sessionId;
    this._drainMsg.sessionId = this.sessionId;

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
    this.queueDepth++;
    this.queuedBytes = this.chunkQueue.bytes;
    this.wake();
  }

  onClose(): void {
    if (this.isTerminal() || this.inputClosed) return;
    this.inputClosed = true;
    this.wake();
  }

  async onCancel(reason?: string): Promise<void> {
    if (this.ended || this.cancelled) return;
    this.cancelled = true;
    this.paused = false;
    this.postMetric("dropped_due_to_cancel", 1);
    if (reason !== "release_state") {
      const msg: MsgDecodeCancelled = {
        type: "decode_cancelled",
        sessionId: this.sessionId,
      };
      self.postMessage(msg);
    }
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
    // finishSession() is the single path that sets ended=true for all terminal
    // states; this.ended is always true when any individual state flag is set.
    return this.ended;
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
    this.chunkQueue.clear();
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
    this.disposePromise = Promise.resolve(decoder.dispose()).catch((e: unknown) => {
      console.error('[jxl-worker] disposeActiveDecoder failed:', e);
    });
    return this.disposePromise;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private waitForChunk(): Promise<void> {
    if (this.chunkQueue.size > 0 || this.inputClosed || this.isTerminal()) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => { this.wakeResolve = resolve; });
  }

  private waitForResume(): Promise<void> {
    if (!this.paused) return Promise.resolve();
    return new Promise<void>((resolve) => { this.resumeResolve = resolve; });
  }

  private takeNextChunk(): ArrayBuffer | null {
    const chunk = this.chunkQueue.shift();
    if (chunk === null) return null;
    this.queueDepth--;
    this.queuedBytes = this.chunkQueue.bytes;
    return chunk;
  }

  private async feedDecoder(decoder: BrowserDecoder): Promise<void> {
    while (!this.ended) {
      if (this.paused) {
        await this.waitForResume();
        continue;
      }

      // Skip the await when chunks are already queued — avoids a microtask
      // yield on every outer iteration during active streaming.
      if (this.chunkQueue.size === 0 && !this.inputClosed) {
        await this.waitForChunk();
        if (this.ended || this.paused) continue;
      }

      while (!this.ended && this.chunkQueue.size > 0) {
        if (this.paused) break;
        const chunk = this.takeNextChunk();
        if (chunk === null) break;

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

  private maybePostDrain(now: number): void {
    const hwm = this.adaptiveHwm();

    const drainAllowed = this.queueDepth < hwm && this.queuedBytes < BYTE_DRAIN_HWM;

    const crossedIntoDrain = drainAllowed && !this.lastDrainAllowed;
    const intervalElapsed = now - this.lastDrainPostedMs >= DRAIN_MIN_INTERVAL_MS;

    this.lastDrainAllowed = drainAllowed;

    if (!drainAllowed) return;
    if (!crossedIntoDrain && !intervalElapsed) return;

    this.lastDrainPostedMs = now;

    this._drainMsg.latencyMs = Math.round(this.pushLatencyEma);
    this._drainMsg.queueDepth = this.queueDepth;
    this._drainMsg.queuedBytes = this.queuedBytes;
    this._drainMsg.adaptiveHwm = hwm;
    self.postMessage(this._drainMsg);
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
          if (this.checkBudget()) {
            this.postMetric("dropped_due_to_budget", 1);
            this.postBudgetExceeded(event.stage, event.info, new ArrayBuffer(0), event.format, event.pixelStride, event.region);
            return;
          }
          const t0 = performance.now();
          const transfer = toTransferablePixels(event.pixels);
          const tToArray = performance.now() - t0;
          this.copyLatencyEma = HWM_EMA_ALPHA * tToArray + (1 - HWM_EMA_ALPHA) * this.copyLatencyEma;
          this.postMetric("copy_to_transfer_ms", tToArray);
          this.postMetric("copied_bytes", transfer.copied ? transfer.buffer.byteLength : 0);

          // Budget check BEFORE transferring pixels. postMessage([pixels]) detaches the
          // buffer — reusing it in postBudgetExceeded would send a zero-length payload.
          if (this.checkBudget()) {
            this.postMetric("dropped_due_to_budget", 1);
            this.postBudgetExceeded(event.stage, event.info, transfer.buffer, event.format, event.pixelStride, event.region);
            return;
          }
          const msg: MsgDecodeProgress = {
            type: "decode_progress",
            sessionId: this.sessionId,
            stage: event.stage,
            info: event.info,
            pixels: transfer.buffer,
            format: event.format,
            pixelStride: event.pixelStride,
          };
          if (event.region !== undefined) msg.region = event.region;
          if (event.sourceScale !== undefined) msg.sourceScale = event.sourceScale;
          if (event.progressiveRegion !== undefined) msg.progressiveRegion = event.progressiveRegion;
          if (event.regionFallback !== undefined) msg.regionFallback = event.regionFallback;
          if (event.progressiveSequence !== undefined) msg.progressiveSequence = event.progressiveSequence;
          if (event.passOrdinal !== undefined) msg.passOrdinal = event.passOrdinal;
          if (event.frameIndex !== undefined) msg.frameIndex = event.frameIndex;
          if (event.frameDuration !== undefined) msg.frameDuration = event.frameDuration;
          if (event.frameName !== undefined) msg.frameName = event.frameName;
          if (event.animTicksPerSecond !== undefined) msg.animTicksPerSecond = event.animTicksPerSecond;
          self.postMessage(msg, [transfer.buffer]);
          this.postFirstPixelMetric();
          if (this.opts.progressionTarget !== "final" && !this.opts.emitEveryPass) {
            this.finishSession("final");
            return;
          }
          break;
        }
        case "final": {
          if (this.checkBudget()) {
            this.postMetric("dropped_due_to_budget", 1);
            this.postBudgetExceeded("final", event.info, new ArrayBuffer(0), event.format, event.pixelStride, event.region);
            return;
          }
          const t0 = performance.now();
          const transfer = toTransferablePixels(event.pixels);
          const tToArray = performance.now() - t0;
          this.copyLatencyEma = HWM_EMA_ALPHA * tToArray + (1 - HWM_EMA_ALPHA) * this.copyLatencyEma;
          this.postMetric("copy_to_transfer_ms", tToArray);
          this.postMetric("copied_bytes", transfer.copied ? transfer.buffer.byteLength : 0);

          // Budget check BEFORE transferring pixels — same pattern as "progress".
          // postMessage([pixels]) detaches the buffer; reusing it in postBudgetExceeded
          // would send a zero-length payload.
          if (this.checkBudget()) {
            this.postMetric("dropped_due_to_budget", 1);
            this.postBudgetExceeded("final", event.info, transfer.buffer, event.format, event.pixelStride, event.region);
            return;
          }
          const now = performance.now();
          const msg: MsgDecodeFinal = {
            type: "decode_final",
            sessionId: this.sessionId,
            info: event.info,
            pixels: transfer.buffer,
            format: event.format,
            pixelStride: event.pixelStride,
            outputBytes: transfer.buffer.byteLength,
            timeToFinalMs: now - this.stageStartMs,
          };
          if (event.region !== undefined) msg.region = event.region;
          if (event.sourceScale !== undefined) msg.sourceScale = event.sourceScale;
          if (event.progressiveRegion !== undefined) msg.progressiveRegion = event.progressiveRegion;
          if (event.regionFallback !== undefined) msg.regionFallback = event.regionFallback;
          if (event.progressiveSequence !== undefined) msg.progressiveSequence = event.progressiveSequence;
          if (event.passOrdinal !== undefined) msg.passOrdinal = event.passOrdinal;
          if (event.frameIndex !== undefined) msg.frameIndex = event.frameIndex;
          if (event.frameDuration !== undefined) msg.frameDuration = event.frameDuration;
          if (event.frameName !== undefined) msg.frameName = event.frameName;
          if (event.animTicksPerSecond !== undefined) msg.animTicksPerSecond = event.animTicksPerSecond;
          // Embed first-pixel timing if it hasn't been reported via a progress event.
          if (!this.firstPixelMetricPosted) {
            msg.timeToFirstPixelMs = now - this.stageStartMs;
            this.postFirstPixelMetric();
          }
          self.postMessage(msg, [transfer.buffer]);
          this.finishSession("final");
          return;
        }
        case "budget_exceeded": {
          const transfer = toTransferablePixels(event.pixels);
          this.postMetric("copy_to_transfer_ms", 0);
          this.postMetric("copied_bytes", transfer.copied ? transfer.buffer.byteLength : 0);
          this.postMetric("dropped_due_to_budget", 1);
          this.postBudgetExceeded(event.stage, event.info, transfer.buffer, event.format, event.pixelStride, event.region);
          return;
        }
        case "error": {
          this.failSession(
            event.code,
            event.message,
            event.partialPixels !== undefined ? toArrayBuffer(event.partialPixels) : undefined,
            event.partialInfo,
            event.partialPixelStride ?? (event.partialPixels !== undefined ? pixelStrideForFormat(this.opts.format) : undefined),
            event.partialStage,
          );
          return;
        }
      }
    }
  }

  private adaptiveHwm(): number {
    const ema = Math.max(this.pushLatencyEma, this.copyLatencyEma);
    if (Math.abs(ema - this._hwmLastEma) < 1.0) return this._cachedHwm;
    this._hwmLastEma = ema;
    const factor = Math.max(0.6, Math.min(2.0, 120 / (ema + 10)));
    this._cachedHwm = Math.floor(HWM_BASE * factor);
    return this._cachedHwm;
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
      if (partialPixelStride !== undefined) msg.partialPixelStride = partialPixelStride;
      if (partialStage !== undefined) msg.partialStage = partialStage;
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
    this._metricInner.name = name;
    this._metricInner.value = value;
    self.postMessage(this._metricMsg);
  }
}

function toTransferablePixels(value: ArrayBuffer | Uint8Array): { buffer: ArrayBuffer; copied: boolean } {
  if (value instanceof ArrayBuffer) return { buffer: value, copied: false };
  if (value.byteOffset === 0 && value.byteLength === value.buffer.byteLength) {
    return { buffer: value.buffer as ArrayBuffer, copied: false };
  }
  return {
    buffer: value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer,
    copied: true,
  };
}

function toArrayBuffer(value: ArrayBuffer | Uint8Array): ArrayBuffer {
  return toTransferablePixels(value).buffer;
}

function pixelStrideForFormat(format: PixelFormat): number {
  if (format === "rgb8") return 3;
  return format === "rgbaf32" ? 16 : format === "rgba16" ? 8 : 4;
}
