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
  MsgDecodeBudgetExceeded,
} from "@casabio/jxl-core/protocol";
import type { ImageInfo, DecodeStage } from "@casabio/jxl-core/types";

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

// High-water mark for incoming chunk queue depth before signalling drain.
const CHUNK_HWM = 4;

export class DecodeHandler {
  private readonly sessionId: string;
  private readonly opts: MsgDecodeStart;
  private readonly wasm: JxlModule;
  private readonly callbacks: DecodeHandlerCallbacks;

  private state: DecodeState = "created";
  private chunkQueue: ArrayBuffer[] = [];
  private chunkReadIndex = 0;
  private queueDepth = 0;
  private cancelled = false;
  private inputClosed = false;
  private wakeResolve: (() => void) | null = null;

  // Stage budget tracking
  private stageStartMs: number = performance.now();
  private currentStage: DecodeStage = "header";

  constructor(
    opts: MsgDecodeStart,
    wasm: JxlModule,
    callbacks: DecodeHandlerCallbacks,
  ) {
    this.sessionId = opts.sessionId;
    this.opts = opts;
    this.wasm = wasm;
    this.callbacks = callbacks;

    // Start processing asynchronously.
    this.run().catch((err: unknown) => this.failSession("Internal", String(err)));
  }

  // ---------------------------------------------------------------------------
  // Incoming message handlers (called by worker.ts router)
  // ---------------------------------------------------------------------------

  onChunk(chunk: ArrayBuffer): void {
    if (this.cancelled || this.state === "final") return;
    this.chunkQueue.push(chunk);
    this.queueDepth++;
    this.wakeResolve?.();
    this.wakeResolve = null;
  }

  onClose(): void {
    this.inputClosed = true;
    this.wakeResolve?.();
    this.wakeResolve = null;
  }

  async onCancel(reason?: string): Promise<void> {
    if (this.cancelled) return;
    this.cancelled = true;
    this.state = "cancelled";
    this.wakeResolve?.();
    this.wakeResolve = null;

    const msg: MsgDecodeCancelled = {
      type: "decode_cancelled",
      sessionId: this.sessionId,
    };
    self.postMessage(msg);
    this.callbacks.onSessionEnd(this.sessionId);
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
    });

    try {
      await Promise.all([this.feedDecoder(decoder), this.readDecoderEvents(decoder)]);
    } finally {
      await decoder.dispose();
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private waitForChunk(): Promise<void> {
    if (this.chunkQueue.length > this.chunkReadIndex || this.inputClosed || this.cancelled
        || this.state === "final" || this.state === "error" || this.state === "budget_exceeded") {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => { this.wakeResolve = resolve; });
  }

  private async feedDecoder(decoder: BrowserDecoder): Promise<void> {
    while (!this.cancelled && this.state !== "final" && this.state !== "error") {
      await this.waitForChunk();
      while (this.chunkQueue.length > this.chunkReadIndex) {
        const chunk = this.chunkQueue[this.chunkReadIndex++];
        if (chunk === undefined) break;
        if (this.chunkReadIndex > 64 && this.chunkReadIndex * 2 > this.chunkQueue.length) {
          this.chunkQueue = this.chunkQueue.slice(this.chunkReadIndex);
          this.chunkReadIndex = 0;
        }
        this.queueDepth--;
        await decoder.push(chunk);
        if (this.queueDepth < CHUNK_HWM) {
          self.postMessage({ type: "worker_drain", sessionId: this.sessionId });
        }
      }
      if (this.inputClosed) {
        await decoder.close();
        return;
      }
    }
  }

  private async readDecoderEvents(decoder: BrowserDecoder): Promise<void> {
    for await (const event of decoder.events()) {
      if (this.cancelled || this.state === "final" || this.state === "error") return;
      switch (event.type) {
        case "header": {
          this.state = "headers";
          const msg: MsgDecodeHeader = { type: "decode_header", sessionId: this.sessionId, info: event.info };
          self.postMessage(msg);
          this.postMetric("time_to_header_ms", performance.now() - this.stageStartMs);
          if (this.opts.progressionTarget === "header") {
            this.state = "final";
            this.callbacks.onSessionEnd(this.sessionId);
            return;
          }
          break;
        }
        case "progress": {
          this.state = "progressive";
          const pixels = toArrayBuffer(event.pixels);
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
          this.postMetric("time_to_first_pixel_ms", performance.now() - this.stageStartMs);
          if (this.checkBudget(event.stage)) {
            this.postBudgetExceeded(event.stage, event.info, pixels, event.format, event.pixelStride);
            return;
          }
          break;
        }
        case "final": {
          const pixels = toArrayBuffer(event.pixels);
          const msg: MsgDecodeFinal = {
            type: "decode_final",
            sessionId: this.sessionId,
            info: event.info,
            pixels,
            format: event.format,
            pixelStride: event.pixelStride,
          };
          if (event.region !== undefined) msg.region = event.region;
          this.state = "final";
          self.postMessage(msg, [pixels]);
          this.postMetric("time_to_final_ms", performance.now() - this.stageStartMs);
          this.callbacks.onSessionEnd(this.sessionId);
          return;
        }
        case "budget_exceeded": {
          this.postBudgetExceeded(event.stage, event.info, toArrayBuffer(event.pixels), event.format, event.pixelStride);
          return;
        }
        case "error": {
          this.failSession(event.code, event.message);
          return;
        }
      }
    }
  }

  private checkBudget(stage: DecodeStage): boolean {
    if (this.opts.budgetMs === null) return false;
    const elapsed = performance.now() - this.stageStartMs;
    return elapsed > this.opts.budgetMs;
  }

  private failSession(code: string, message: string): void {
    if (this.cancelled || this.state === "final") return;
    this.state = "error";

    const msg: MsgDecodeError = {
      type: "decode_error",
      sessionId: this.sessionId,
      code,
      message,
    };
    self.postMessage(msg);
    this.callbacks.onSessionEnd(this.sessionId);
  }

  private postBudgetExceeded(
    stage: DecodeStage,
    info: ImageInfo,
    pixels: ArrayBuffer,
    format: MsgDecodeBudgetExceeded["format"],
    pixelStride: number,
  ): void {
    if (this.cancelled || this.state === "final") return;
    this.state = "budget_exceeded";
    const msg: MsgDecodeBudgetExceeded = {
      type: "decode_budget_exceeded",
      sessionId: this.sessionId,
      stage,
      pixels,
      info,
      format,
      pixelStride,
    };
    self.postMessage(msg, [pixels]);
    this.callbacks.onSessionEnd(this.sessionId);
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
