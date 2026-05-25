// jxl-worker-browser/src/encode-handler.ts
// Encode session handler. Owns one libjxl encoder instance per session.
// Spec: Sections 11, 16.2.
//
// Drives the WASM codec facade; generated libjxl adapter lands with T-WASM-BUILD.

/// <reference lib="webworker" />

import type { BrowserEncoder, JxlModule } from "./wasm-loader.js";
import type {
  MsgEncodeStart,
  MsgEncodeChunk,
  MsgEncodeFirstByteReady,
  MsgEncodeDone,
  MsgEncodeError,
  MsgEncodeCancelled,
} from "@casabio/jxl-core/protocol";
import type { Region } from "@casabio/jxl-core/types";

type EncodeState =
  | "created"
  | "configured"
  | "streaming"
  | "finalising"
  | "done"
  | "cancelled"
  | "error";

interface EncodeHandlerCallbacks {
  onSessionEnd: (sessionId: string) => void;
}

const CHUNK_HWM = 4;
const DRAIN_MIN_INTERVAL_MS = 8;

export class EncodeHandler {
  private readonly sessionId: string;
  private readonly opts: MsgEncodeStart;
  private readonly wasm: JxlModule;
  private readonly callbacks: EncodeHandlerCallbacks;

  private state: EncodeState = "created";
  private pixelQueue: Array<{ chunk: ArrayBuffer; region?: Region }> = [];
  private pixelReadIndex = 0;
  private queueDepth = 0;
  private cancelled = false;
  private finished = false;
  private firstByteEmitted = false;
  private wakeResolve: (() => void) | null = null;
  private lastDrainPostedMs = 0;
  private lastDrainAllowed = false;

  constructor(
    opts: MsgEncodeStart,
    wasm: JxlModule,
    callbacks: EncodeHandlerCallbacks,
  ) {
    this.sessionId = opts.sessionId;
    this.opts = opts;
    this.wasm = wasm;
    this.callbacks = callbacks;

    this.run().catch((err: unknown) => this.failSession("Internal", String(err)));
  }

  // ---------------------------------------------------------------------------
  // Incoming message handlers
  // ---------------------------------------------------------------------------

  onPixels(chunk: ArrayBuffer, region?: Region): void {
    if (this.cancelled || this.state === "done") return;
    const entry: { chunk: ArrayBuffer; region?: Region } = { chunk };
    if (region !== undefined) entry.region = region;
    this.pixelQueue.push(entry);
    this.queueDepth++;
    this.wakeResolve?.();
    this.wakeResolve = null;
  }

  onFinish(): void {
    this.finished = true;
    this.wakeResolve?.();
    this.wakeResolve = null;
  }

  async onCancel(reason?: string): Promise<void> {
    if (this.cancelled || this.state === "done" || this.state === "error") return;
    this.cancelled = true;
    this.state = "cancelled";
    this.wakeResolve?.();
    this.wakeResolve = null;

    const msg: MsgEncodeCancelled = {
      type: "encode_cancelled",
      sessionId: this.sessionId,
    };
    self.postMessage(msg);
    this.callbacks.onSessionEnd(this.sessionId);
  }

  // ---------------------------------------------------------------------------
  // Main encode loop
  // ---------------------------------------------------------------------------

  private async run(): Promise<void> {
    const encoder = this.wasm.createEncoder({
      format: this.opts.format,
      width: this.opts.width,
      height: this.opts.height,
      hasAlpha: this.opts.hasAlpha,
      iccProfile: this.opts.iccProfile,
      exif: this.opts.exif,
      xmp: this.opts.xmp,
      distance: this.opts.distance,
      quality: this.opts.quality,
      effort: this.opts.effort,
      progressive: this.opts.progressive,
      previewFirst: this.opts.previewFirst,
      chunked: this.opts.chunked,
      sidecarSizes: this.opts.sidecarSizes,
    });
    this.state = "configured";
    try {
      await Promise.all([this.feedEncoder(encoder), this.readEncoderChunks(encoder)]);
    } finally {
      await encoder.dispose();
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private waitForPixels(): Promise<void> {
    if (this.pixelQueue.length > this.pixelReadIndex || this.finished || this.cancelled
        || this.state === "done" || this.state === "error") {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => { this.wakeResolve = resolve; });
  }

  private async feedEncoder(encoder: BrowserEncoder): Promise<void> {
    while (!this.cancelled && this.state !== "done" && this.state !== "error") {
      await this.waitForPixels();
      while (this.pixelQueue.length > this.pixelReadIndex) {
        const entry = this.pixelQueue[this.pixelReadIndex++];
        if (entry === undefined) break;
        if (this.pixelReadIndex > 64 && this.pixelReadIndex * 2 > this.pixelQueue.length) {
          this.pixelQueue.copyWithin(0, this.pixelReadIndex);
          this.pixelQueue.length -= this.pixelReadIndex;
          this.pixelReadIndex = 0;
        }
        this.queueDepth--;
        await encoder.pushPixels(entry.chunk, entry.region);
        this.maybePostDrain();
      }
      if (this.finished) {
        this.state = "finalising";
        await encoder.finish();
        return;
      }
    }
  }

  private maybePostDrain(): void {
    const now = performance.now();
    const drainAllowed = this.queueDepth < CHUNK_HWM;

    const crossedIntoDrain = drainAllowed && !this.lastDrainAllowed;
    const intervalElapsed = now - this.lastDrainPostedMs >= DRAIN_MIN_INTERVAL_MS;

    this.lastDrainAllowed = drainAllowed;

    if (!drainAllowed) return;
    if (!crossedIntoDrain && !intervalElapsed) return;

    this.lastDrainPostedMs = now;

    self.postMessage({ type: "worker_drain", sessionId: this.sessionId });
  }

  private async readEncoderChunks(encoder: BrowserEncoder): Promise<void> {
    let totalBytes = 0;
    for await (const chunk of encoder.chunks()) {
      if (this.cancelled || this.state === "done" || this.state === "error") return;
      const buffer = toArrayBuffer(chunk);
      if (!this.firstByteEmitted) {
        this.firstByteEmitted = true;
        const firstByteMsg: MsgEncodeFirstByteReady = {
          type: "encode_first_byte_ready",
          sessionId: this.sessionId,
        };
        self.postMessage(firstByteMsg);
      }
      totalBytes += buffer.byteLength;
      const msg: MsgEncodeChunk = {
        type: "encode_chunk",
        sessionId: this.sessionId,
        chunk: buffer,
      };
      this.state = "streaming";
      self.postMessage(msg, [buffer]);
    }

    if (this.cancelled || this.state === "done" || this.state === "error") return;
    this.state = "done";
    const doneMsg: MsgEncodeDone = {
      type: "encode_done",
      sessionId: this.sessionId,
      totalBytes,
    };
    self.postMessage(doneMsg);
    this.callbacks.onSessionEnd(this.sessionId);
  }

  private failSession(code: string, message: string): void {
    if (this.cancelled || this.state === "done" || this.state === "error") return;
    this.state = "error";
    // Unblock feedEncoder if it's sleeping in waitForPixels.
    this.wakeResolve?.();
    this.wakeResolve = null;

    const msg: MsgEncodeError = {
      type: "encode_error",
      sessionId: this.sessionId,
      code,
      message,
    };
    self.postMessage(msg);
    this.callbacks.onSessionEnd(this.sessionId);
  }
}

function toArrayBuffer(value: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  return value.byteOffset === 0 && value.byteLength === value.buffer.byteLength
    ? value.buffer
    : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
}
