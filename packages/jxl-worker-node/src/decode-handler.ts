// jxl-worker-node/src/decode-handler.ts
// Decode session handler for node:worker_threads.
// Same protocol as jxl-worker-browser/decode-handler.ts.
// Drives the selected native/WASM backend facade.

import type { MessagePort } from "node:worker_threads";
import type { Backend } from "./backend-selector.js";
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
import type { DecodeStage, ImageInfo, PixelFormat, Region } from "@casabio/jxl-core/types";

type DecodeState = "created" | "headers" | "progressive" | "final" | "cancelled" | "error" | "budget_exceeded";

interface DecodeHandlerCallbacks {
  onSessionEnd: (sessionId: string) => void;
  port: MessagePort;
}

// Adaptive drain HWM: EMA of decoder.push() latency scales the drain threshold.
// Mirrors the browser decode-handler's coalescing strategy exactly.
// Adaptive drain is meaningful for streaming backends (WASM); the batch native
// backend decodes inside close(), so these gates (HWM, EMA, BYTE_DRAIN_HWM) are
// inert there — push() is ~0 ms memcpy and full decode happens before any events flow.
const HWM_BASE = 6;
const HWM_EMA_ALPHA = 0.25;
const MAX_QUEUED_BYTES = 128 * 1024 * 1024; // 128 MiB safety cap — see browser handler
const DRAIN_MIN_INTERVAL_MS = 8;
const BYTE_DRAIN_HWM = 2 * 1024 * 1024; // 2 MiB — byte-level secondary drain gate

type NodeDecodeEvent =
  | { type: "header"; info: ImageInfo }
  | { type: "progress"; stage: DecodeStage; info: ImageInfo; pixels: ArrayBuffer | Uint8Array | Buffer; format: PixelFormat; region?: Region; pixelStride: number }
  | { type: "final"; info: ImageInfo; pixels: ArrayBuffer | Uint8Array | Buffer; format: PixelFormat; region?: Region; pixelStride: number }
  | { type: "budget_exceeded"; stage: DecodeStage; info: ImageInfo; pixels: ArrayBuffer | Uint8Array | Buffer; format: PixelFormat; pixelStride: number }
  | { type: "error"; code: string; message: string };

interface NodeDecoder {
  push(chunk: Buffer): void | Promise<void>;
  close(): void | Promise<void>;
  events(): AsyncIterable<NodeDecodeEvent>;
  cancel(reason?: string): void | Promise<void>;
  dispose(): void | Promise<void>;
}

interface NodeCodecModule {
  createDecoder(options: {
    format: PixelFormat;
    region: Region | null;
    downsample: 1 | 2 | 4 | 8;
    progressionTarget: "header" | "dc" | "pass" | "final";
    emitEveryPass: boolean;
    progressiveDetail?: "dc" | "lastPasses" | "passes" | "dcProgressive";
    preserveIcc: boolean;
    preserveMetadata: boolean;
  }): NodeDecoder;
}

export class DecodeHandler {
  private readonly sessionId: string;
  private readonly opts: MsgDecodeStart;
  private readonly backend: Backend;
  private readonly port: MessagePort;
  private readonly callbacks: DecodeHandlerCallbacks;

  private state: DecodeState = "created";
  private chunkQueue: Array<Buffer | undefined> = [];
  private chunkReadIndex = 0;
  private queueDepth = 0;
  private queuedBytes = 0;
  private cancelled = false;
  private ended = false;
  private inputClosed = false;
  private paused = false;
  private readonly stageStartMs = performance.now();
  private firstPixelMetricPosted = false;
  private decoder: NodeDecoder | null = null;
  private disposePromise: Promise<void> | null = null;

  // Wake/resume coordination — avoids polling; mirrors browser handler.
  private wakeResolve: (() => void) | null = null;
  private resumeResolve: (() => void) | null = null;

  // Drain coalescing state — mirrors browser decode-handler exactly.
  private lastDrainPostedMs = 0;
  private lastDrainAllowed = false;
  private pushLatencyEma = 0;

  constructor(opts: MsgDecodeStart, backend: Backend, callbacks: DecodeHandlerCallbacks) {
    this.sessionId = opts.sessionId;
    this.opts = opts;
    this.backend = backend;
    this.port = callbacks.port;
    this.callbacks = callbacks;

    this.run().catch((err: unknown) => this.failSession("Internal", String(err)));
  }

  // Accept both Buffer and Uint8Array per spec Section 15.2
  onChunk(chunk: ArrayBuffer | Uint8Array | Buffer): void {
    if (this.isTerminal() || this.inputClosed) return;
    if (chunk.byteLength === 0) return;
    if (this.queuedBytes + chunk.byteLength > MAX_QUEUED_BYTES) {
      this.failSession("QueueOverflow", `Input queue exceeded ${MAX_QUEUED_BYTES >> 20} MiB`);
      return;
    }
    const isAB = chunk instanceof ArrayBuffer;
    const buf = Buffer.from(
      isAB ? chunk : chunk.buffer,
      isAB ? 0 : (chunk as Uint8Array).byteOffset,
      isAB ? chunk.byteLength : (chunk as Uint8Array).byteLength,
    );
    this.chunkQueue.push(buf);
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
    const msg: MsgDecodeCancelled = { type: "decode_cancelled", sessionId: this.sessionId };
    this.port.postMessage(msg);
    this.finishSession("cancelled");
    void this.disposeActiveDecoder();
  }

  onPause(): void {
    if (this.isTerminal() || this.paused) return;
    this.paused = true;
    this.wake(); // wake feedDecoder so it reaches the pause check immediately
    const msg: MsgDecodePaused = { type: "decode_paused", sessionId: this.sessionId };
    this.port.postMessage(msg);
  }

  onResume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.wakeResume();
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

  // Single path for all session endings. Wakes both sleeping loops so
  // Promise.all resolves promptly and decoder.dispose runs without delay.
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

  // ---------------------------------------------------------------------------
  // Main decode loop
  // ---------------------------------------------------------------------------

  private async run(): Promise<void> {
    const codec = this.backend.module as NodeCodecModule;
    const decoder = codec.createDecoder({
      format: this.opts.format,
      region: this.opts.region,
      downsample: this.opts.downsample,
      progressionTarget: this.opts.progressionTarget,
      emitEveryPass: this.opts.emitEveryPass,
      ...(this.opts.progressiveDetail !== null ? { progressiveDetail: this.opts.progressiveDetail } : {}),
      preserveIcc: this.opts.preserveIcc,
      preserveMetadata: this.opts.preserveMetadata,
    });
    this.decoder = decoder;

    try {
      await Promise.all([this.feedDecoder(decoder), this.readDecoderEvents(decoder)]);
    } catch (err: unknown) {
      if (!this.isTerminal()) {
        this.failSession("Internal", err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (!this.ended) {
        this.failSession("Internal", "decoder event stream ended without a terminal event");
      }
      await this.disposeActiveDecoder();
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

  private takeNextChunk(): Buffer | null {
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

  private async feedDecoder(decoder: NodeDecoder): Promise<void> {
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

  private adaptiveHwm(): number {
    const factor = Math.max(0.6, Math.min(2.0, 120 / (this.pushLatencyEma + 10)));
    return Math.floor(HWM_BASE * factor);
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

    this.port.postMessage({
      type: "worker_drain",
      sessionId: this.sessionId,
      latencyMs: Math.round(this.pushLatencyEma),
      queueDepth: this.queueDepth,
      queuedBytes: this.queuedBytes,
      adaptiveHwm: hwm,
    });
  }

  private async readDecoderEvents(decoder: NodeDecoder): Promise<void> {
    for await (const event of decoder.events()) {
      if (this.isTerminal()) return;
      switch (event.type) {
        case "header": {
          this.state = "headers";
          const msg: MsgDecodeHeader = { type: "decode_header", sessionId: this.sessionId, info: event.info };
          this.port.postMessage(msg);
          this.postMetric("time_to_header_ms", performance.now() - this.stageStartMs);
          if (this.opts.progressionTarget === "header") {
            this.finishSession("final");
            return;
          }
          break;
        }
        case "progress": {
          this.state = "progressive";
          const pixels = toBuffer(event.pixels);
          // Budget check BEFORE posting pixels — mirrors browser. postWithPixels
          // transfers the underlying ArrayBuffer when the Buffer owns it wholly
          // (native binding case); small views fall back to clone. No reuse after post.
          if (this.checkBudget()) {
            this.postBudgetExceeded(event.stage, event.info, pixels, event.format, event.pixelStride);
            return;
          }
          const msg: MsgDecodeProgress = {
            type: "decode_progress",
            sessionId: this.sessionId,
            stage: event.stage,
            info: event.info,
            pixels: pixels as unknown as ArrayBuffer,
            format: event.format,
            pixelStride: event.pixelStride,
          };
          if (event.region !== undefined) msg.region = event.region;
          this.postWithPixels(msg, pixels);
          this.postFirstPixelMetric();
          break;
        }
        case "final": {
          const pixels = toBuffer(event.pixels);
          // Budget check BEFORE posting pixels — mirrors browser handler's
          // "final" budget check (browser decode-handler.ts lines 407-409).
          if (this.checkBudget()) {
            this.postBudgetExceeded("final", event.info, pixels, event.format, event.pixelStride);
            return;
          }
          const msg: MsgDecodeFinal = {
            type: "decode_final",
            sessionId: this.sessionId,
            info: event.info,
            pixels: pixels as unknown as ArrayBuffer,
            format: event.format,
            pixelStride: event.pixelStride,
          };
          if (event.region !== undefined) msg.region = event.region;
          this.postWithPixels(msg, pixels);
          this.postFirstPixelMetric();
          this.postMetric("time_to_final_ms", performance.now() - this.stageStartMs);
          this.finishSession("final");
          return;
        }
        case "budget_exceeded": {
          this.postBudgetExceeded(event.stage, event.info, toBuffer(event.pixels), event.format, event.pixelStride);
          return;
        }
        case "error": {
          this.failSession(event.code, event.message);
          return;
        }
      }
    }
  }

  private failSession(code: string, message: string): void {
    if (this.ended) return;
    const msg: MsgDecodeError = { type: "decode_error", sessionId: this.sessionId, code, message };
    this.port.postMessage(msg);
    this.finishSession("error");
    // Best-effort unblock of decoder.events() iterator — mirrors browser handler.
    void this.disposeActiveDecoder();
  }

  private checkBudget(): boolean {
    if (this.opts.budgetMs == null) return false;
    return performance.now() - this.stageStartMs > this.opts.budgetMs;
  }

  private postWithPixels(msg: object, pixels: Buffer): void {
    const ab = pixels.buffer;
    const owns = pixels.byteOffset === 0 && pixels.byteLength === ab.byteLength;
    this.port.postMessage(msg, owns ? [ab] : []);
  }

  private postBudgetExceeded(stage: DecodeStage, info: ImageInfo, pixels: Buffer, format: PixelFormat, pixelStride: number): void {
    if (this.ended) return;
    const msg: MsgDecodeBudgetExceeded = {
      type: "decode_budget_exceeded",
      sessionId: this.sessionId,
      stage,
      pixels: pixels as unknown as ArrayBuffer,
      info,
      format,
      pixelStride,
    };
    this.postWithPixels(msg, pixels);
    this.finishSession("budget_exceeded");
    // Best-effort unblock of decoder.events() iterator — mirrors browser handler.
    void this.disposeActiveDecoder();
  }

  private postFirstPixelMetric(): void {
    if (this.firstPixelMetricPosted) return;
    this.firstPixelMetricPosted = true;
    this.postMetric("time_to_first_pixel_ms", performance.now() - this.stageStartMs);
  }

  private postMetric(name: string, value: number): void {
    this.port.postMessage({
      type: "metric",
      sessionId: this.sessionId,
      metric: { name, value },
    });
  }
}

function toBuffer(value: ArrayBuffer | Uint8Array | Buffer): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}
