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

const CHUNK_HWM = 4;
const MAX_QUEUED_BYTES = 128 * 1024 * 1024; // 128 MiB safety cap — see browser handler

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
  private disposingDecoder = false;

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
    const buf = Buffer.from(
      chunk instanceof ArrayBuffer ? chunk : chunk.buffer,
      chunk instanceof ArrayBuffer ? 0 : (chunk as Uint8Array).byteOffset,
      chunk instanceof ArrayBuffer ? chunk.byteLength : (chunk as Uint8Array).byteLength,
    );
    this.chunkQueue.push(buf);
    this.queuedBytes += chunk.byteLength;
    this.queueDepth++;
  }

  onClose(): void {
    if (this.isTerminal() || this.inputClosed) return;
    this.inputClosed = true;
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
    if (this.cancelled || this.paused || this.state === "final" || this.state === "error") return;
    this.paused = true;
    const msg: MsgDecodePaused = { type: "decode_paused", sessionId: this.sessionId };
    this.port.postMessage(msg);
  }

  onResume(): void {
    if (!this.paused) return;
    this.paused = false;
    // waitForChunk polling detects paused=false within 2 ms.
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

  // Single path for all session endings. No explicit wake needed — the polling
  // loop in waitForChunk detects isTerminal() within 2 ms.
  private finishSession(state: DecodeState): boolean {
    if (this.ended) return false;
    this.ended = true;
    this.state = state;
    this.clearInputQueue();
    this.callbacks.onSessionEnd(this.sessionId);
    return true;
  }

  private clearInputQueue(): void {
    this.chunkQueue.length = 0;
    this.chunkReadIndex = 0;
    this.queueDepth = 0;
    this.queuedBytes = 0;
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
      this.finishSession(this.state);
      await this.disposeActiveDecoder();
    }
  }

  private async disposeActiveDecoder(): Promise<void> {
    if (this.disposingDecoder) return;
    const decoder = this.decoder;
    if (decoder === null) return;
    this.disposingDecoder = true;
    this.decoder = null;
    try {
      await decoder.dispose();
    } catch {
      // best-effort during terminal cleanup
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private waitForChunk(): Promise<void> {
    return new Promise<void>((resolve) => {
      const check = () => {
        if (this.isTerminal()) { resolve(); return; }
        if (!this.paused && (this.chunkQueue.length > this.chunkReadIndex || this.inputClosed)) {
          resolve(); return;
        }
        setTimeout(check, 2);
      };
      check();
    });
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
      await this.waitForChunk();
      while (!this.isTerminal() && this.chunkQueue.length > this.chunkReadIndex) {
        const chunk = this.takeNextChunk();
        if (chunk === null) break;
        await decoder.push(chunk);
        if (this.checkBudget()) {
          this.finishSession("budget_exceeded");
          return;
        }
        if (this.queueDepth < CHUNK_HWM) {
          this.port.postMessage({ type: "worker_drain", sessionId: this.sessionId });
        }
      }
      if (this.inputClosed && !this.isTerminal()) {
        await decoder.close();
        return;
      }
    }
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
          // Budget check BEFORE using pixels — mirrors the browser handler's
          // detached-buffer fix (Node Buffers aren't transferred but the ordering
          // is correct and symmetric).
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
          this.port.postMessage(msg);
          this.postFirstPixelMetric();
          break;
        }
        case "final": {
          const pixels = toBuffer(event.pixels);
          const msg: MsgDecodeFinal = {
            type: "decode_final",
            sessionId: this.sessionId,
            info: event.info,
            pixels: pixels as unknown as ArrayBuffer,
            format: event.format,
            pixelStride: event.pixelStride,
          };
          if (event.region !== undefined) msg.region = event.region;
          this.port.postMessage(msg);
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
  }

  private checkBudget(): boolean {
    if (this.opts.budgetMs == null) return false;
    return performance.now() - this.stageStartMs > this.opts.budgetMs;
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
    this.port.postMessage(msg);
    this.finishSession("budget_exceeded");
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
