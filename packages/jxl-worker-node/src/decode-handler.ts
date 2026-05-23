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
  private chunkQueue: Buffer[] = [];
  private chunkReadIndex = 0;
  private queueDepth = 0;
  private cancelled = false;
  private inputClosed = false;
  private paused = false;
  private stageStartMs = performance.now();

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
    if (this.cancelled || this.state === "final") return;
    const buf = Buffer.from(chunk instanceof ArrayBuffer ? chunk : chunk.buffer, chunk instanceof ArrayBuffer ? 0 : (chunk as Uint8Array).byteOffset, chunk instanceof ArrayBuffer ? chunk.byteLength : (chunk as Uint8Array).byteLength);
    this.chunkQueue.push(buf);
    this.queueDepth++;
  }

  onClose(): void {
    this.inputClosed = true;
  }

  async onCancel(reason?: string): Promise<void> {
    if (this.cancelled) return;
    this.cancelled = true;
    this.paused = false;
    this.state = "cancelled";

    const msg: MsgDecodeCancelled = { type: "decode_cancelled", sessionId: this.sessionId };
    this.port.postMessage(msg);
    this.callbacks.onSessionEnd(this.sessionId);
  }

  onPause(): void {
    if (this.cancelled || this.state === "final" || this.state === "error") return;
    this.paused = true;
    const msg: MsgDecodePaused = { type: "decode_paused", sessionId: this.sessionId };
    this.port.postMessage(msg);
  }

  onResume(): void {
    this.paused = false;
    // The waitForChunk polling loop notices paused=false within 2ms.
  }

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

    try {
      await Promise.all([this.feedDecoder(decoder), this.readDecoderEvents(decoder)]);
    } finally {
      await decoder.dispose();
    }
  }

  private waitForChunk(): Promise<void> {
    return new Promise<void>((resolve) => {
      const check = () => {
        if (this.cancelled || this.state === "final" || this.state === "error" || this.state === "budget_exceeded") {
          resolve(); return;
        }
        if (!this.paused && (this.chunkQueue.length > this.chunkReadIndex || this.inputClosed)) {
          resolve(); return;
        }
        setTimeout(check, 2);
      };
      check();
    });
  }

  private async feedDecoder(decoder: NodeDecoder): Promise<void> {
    while (!this.cancelled && this.state !== "final" && this.state !== "error" && this.state !== "budget_exceeded") {
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
          this.port.postMessage({ type: "worker_drain", sessionId: this.sessionId });
        }
      }
      if (this.inputClosed) {
        await decoder.close();
        return;
      }
    }
  }

  private async readDecoderEvents(decoder: NodeDecoder): Promise<void> {
    for await (const event of decoder.events()) {
      if (this.cancelled || this.state === "final" || this.state === "error") return;
      switch (event.type) {
        case "header": {
          this.state = "headers";
          const msg: MsgDecodeHeader = { type: "decode_header", sessionId: this.sessionId, info: event.info };
          this.port.postMessage(msg);
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
          const pixels = toBuffer(event.pixels);
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
          this.postMetric("time_to_first_pixel_ms", performance.now() - this.stageStartMs);
          if (this.checkBudget()) {
            this.postBudgetExceeded(event.stage, event.info, pixels, event.format, event.pixelStride);
            return;
          }
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
          this.state = "final";
          this.port.postMessage(msg);
          this.postMetric("time_to_final_ms", performance.now() - this.stageStartMs);
          this.callbacks.onSessionEnd(this.sessionId);
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
    if (this.cancelled || this.state === "final") return;
    this.state = "error";
    const msg: MsgDecodeError = { type: "decode_error", sessionId: this.sessionId, code, message };
    this.port.postMessage(msg);
    this.callbacks.onSessionEnd(this.sessionId);
  }

  private checkBudget(): boolean {
    if (this.opts.budgetMs === null) return false;
    return performance.now() - this.stageStartMs > this.opts.budgetMs;
  }

  private postBudgetExceeded(stage: DecodeStage, info: ImageInfo, pixels: Buffer, format: PixelFormat, pixelStride: number): void {
    if (this.cancelled || this.state === "final") return;
    this.state = "budget_exceeded";
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
    this.callbacks.onSessionEnd(this.sessionId);
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
