// jxl-worker-node/src/encode-handler.ts
// Encode session handler for node:worker_threads.
// BLOCKED on T-NATIVE-BIND + T-ENCODE-NATIVE for real codec calls.

import type { MessagePort } from "node:worker_threads";
import type { Backend } from "./backend-selector.js";
import type {
  MsgEncodeStart,
  MsgEncodeChunk,
  MsgEncodeFirstByteReady,
  MsgEncodeDone,
  MsgEncodeError,
  MsgEncodeCancelled,
} from "@casabio/jxl-core/protocol";
import type { PixelFormat, Region } from "@casabio/jxl-core/types";

type EncodeState = "created" | "configured" | "streaming" | "finalising" | "done" | "cancelled" | "error";

interface EncodeHandlerCallbacks {
  onSessionEnd: (sessionId: string) => void;
  port: MessagePort;
}

interface NodeEncoder {
  pushPixels(chunk: Buffer, region?: Region): void | Promise<void>;
  finish(): void | Promise<void>;
  chunks(): AsyncIterable<ArrayBuffer | Uint8Array | Buffer>;
  cancel(reason?: string): void | Promise<void>;
  dispose(): void | Promise<void>;
}

interface NodeCodecModule {
  createEncoder(options: {
    format: PixelFormat;
    width: number;
    height: number;
    hasAlpha: boolean;
    iccProfile: ArrayBuffer | null;
    exif: ArrayBuffer | null;
    xmp: ArrayBuffer | null;
    distance: number | null;
    quality: number | null;
    effort: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
    progressive: boolean;
    previewFirst: boolean;
    chunked: boolean;
  }): NodeEncoder;
}

const CHUNK_HWM = 4;

export class EncodeHandler {
  private readonly sessionId: string;
  private readonly opts: MsgEncodeStart;
  private readonly backend: Backend;
  private readonly port: MessagePort;
  private readonly callbacks: EncodeHandlerCallbacks;

  private state: EncodeState = "created";
  private pixelQueue: Array<{ chunk: Buffer; region?: Region }> = [];
  private queueDepth = 0;
  private cancelled = false;
  private finished = false;
  private firstByteEmitted = false;

  constructor(opts: MsgEncodeStart, backend: Backend, callbacks: EncodeHandlerCallbacks) {
    this.sessionId = opts.sessionId;
    this.opts = opts;
    this.backend = backend;
    this.port = callbacks.port;
    this.callbacks = callbacks;

    this.run().catch((err: unknown) => this.failSession("Internal", String(err)));
  }

  onPixels(chunk: ArrayBuffer | Uint8Array | Buffer, region?: Region): void {
    if (this.cancelled || this.state === "done") return;
    const buf = Buffer.from(chunk instanceof ArrayBuffer ? chunk : chunk.buffer, chunk instanceof ArrayBuffer ? 0 : (chunk as Uint8Array).byteOffset, chunk instanceof ArrayBuffer ? chunk.byteLength : (chunk as Uint8Array).byteLength);
    const entry: { chunk: Buffer; region?: Region } = { chunk: buf };
    if (region !== undefined) entry.region = region;
    this.pixelQueue.push(entry);
    this.queueDepth++;
  }

  onFinish(): void {
    this.finished = true;
  }

  async onCancel(reason?: string): Promise<void> {
    if (this.cancelled) return;
    this.cancelled = true;
    this.state = "cancelled";

    const msg: MsgEncodeCancelled = { type: "encode_cancelled", sessionId: this.sessionId };
    this.port.postMessage(msg);
    this.callbacks.onSessionEnd(this.sessionId);
  }

  private async run(): Promise<void> {
    const codec = this.backend.module as NodeCodecModule;
    const encoder = codec.createEncoder({
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
    });
    this.state = "configured";

    try {
      await Promise.all([this.feedEncoder(encoder), this.readEncoderChunks(encoder)]);
    } finally {
      await encoder.dispose();
    }
  }

  private waitForPixels(): Promise<void> {
    return new Promise<void>((resolve) => {
      const check = () => {
        if (this.pixelQueue.length > 0 || this.finished || this.cancelled) resolve();
        else if (this.state === "done" || this.state === "error") resolve();
        else setTimeout(check, 2);
      };
      check();
    });
  }

  private async feedEncoder(encoder: NodeEncoder): Promise<void> {
    while (!this.cancelled && this.state !== "done" && this.state !== "error") {
      await this.waitForPixels();
      while (this.pixelQueue.length > 0) {
        const entry = this.pixelQueue.shift();
        if (entry === undefined) break;
        this.queueDepth--;
        await encoder.pushPixels(entry.chunk, entry.region);
        if (this.queueDepth < CHUNK_HWM) {
          this.port.postMessage({ type: "worker_drain", sessionId: this.sessionId });
        }
      }
      if (this.finished) {
        this.state = "finalising";
        await encoder.finish();
        return;
      }
    }
  }

  private async readEncoderChunks(encoder: NodeEncoder): Promise<void> {
    let totalBytes = 0;
    for await (const chunk of encoder.chunks()) {
      if (this.cancelled || this.state === "done" || this.state === "error") return;
      const buffer = toBuffer(chunk);
      if (!this.firstByteEmitted) {
        this.firstByteEmitted = true;
        const msg: MsgEncodeFirstByteReady = {
          type: "encode_first_byte_ready",
          sessionId: this.sessionId,
        };
        this.port.postMessage(msg);
      }
      totalBytes += buffer.byteLength;
      const msg: MsgEncodeChunk = {
        type: "encode_chunk",
        sessionId: this.sessionId,
        chunk: buffer as unknown as ArrayBuffer,
      };
      this.state = "streaming";
      this.port.postMessage(msg);
    }

    if (this.cancelled || this.state === "done" || this.state === "error") return;
    this.state = "done";
    const doneMsg: MsgEncodeDone = {
      type: "encode_done",
      sessionId: this.sessionId,
      totalBytes,
    };
    this.port.postMessage(doneMsg);
    this.callbacks.onSessionEnd(this.sessionId);
  }

  private failSession(code: string, message: string): void {
    if (this.cancelled || this.state === "done") return;
    this.state = "error";
    const msg: MsgEncodeError = { type: "encode_error", sessionId: this.sessionId, code, message };
    this.port.postMessage(msg);
    this.callbacks.onSessionEnd(this.sessionId);
  }
}

function toBuffer(value: ArrayBuffer | Uint8Array | Buffer): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}
