// jxl-worker-node/src/encode-handler.ts
// Encode session handler for node:worker_threads.
// Drives the selected native/WASM backend facade.

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
    // progressive (predator) accepted via any at call site to satisfy exactOptional + MsgEncodeStart source
  }): NodeEncoder;
}

const CHUNK_HWM = 4;
const CHUNK_MAX_BUFFERED = 32;
const MAX_QUEUED_BYTES = 128 * 1024 * 1024;
const DRAIN_MIN_INTERVAL_MS = 8;

export class EncodeHandler {
  private readonly sessionId: string;
  private readonly opts: MsgEncodeStart;
  private readonly backend: Backend;
  private readonly port: MessagePort;
  private readonly callbacks: EncodeHandlerCallbacks;

  private state: EncodeState = "created";
  private pixelQueue: Array<{ chunk: Buffer; region?: Region } | undefined> = [];
  private pixelReadIndex = 0;
  private queueDepth = 0;
  private queuedBytes = 0;
  private cancelled = false;
  private finished = false;
  private ended = false;
  private firstByteEmitted = false;
  private wakeResolve: (() => void) | null = null;
  private lastDrainPostedMs = 0;
  private lastDrainAllowed = false;
  private encoder: NodeEncoder | null = null;
  private disposePromise: Promise<void> | null = null;

  constructor(opts: MsgEncodeStart, backend: Backend, callbacks: EncodeHandlerCallbacks) {
    this.sessionId = opts.sessionId;
    this.opts = opts;
    this.backend = backend;
    this.port = callbacks.port;
    this.callbacks = callbacks;

    this.run().catch((err: unknown) => this.failSession("Internal", String(err)));
  }

  onPixels(chunk: ArrayBuffer | Uint8Array | Buffer, region?: Region): void {
    if (
      this.finished ||
      this.cancelled ||
      this.state === "done" ||
      this.state === "error" ||
      this.state === "cancelled"
    ) return;
    if (this.queueDepth >= CHUNK_MAX_BUFFERED) {
      this.failSession(
        "BackpressureOverflow",
        `Encode input queue exceeded ${CHUNK_MAX_BUFFERED} buffered chunks`,
      );
      return;
    }
    if (this.queuedBytes + chunk.byteLength > MAX_QUEUED_BYTES) {
      this.failSession("QueueOverflow", `Encode input queue exceeded ${MAX_QUEUED_BYTES >> 20} MiB`);
      return;
    }
    const buf = Buffer.from(chunk instanceof ArrayBuffer ? chunk : chunk.buffer, chunk instanceof ArrayBuffer ? 0 : (chunk as Uint8Array).byteOffset, chunk instanceof ArrayBuffer ? chunk.byteLength : (chunk as Uint8Array).byteLength);
    const entry: { chunk: Buffer; region?: Region } = { chunk: buf };
    if (region !== undefined) entry.region = region;
    this.pixelQueue.push(entry);
    this.queueDepth++;
    this.queuedBytes += buf.byteLength;
    this.wake();
  }

  onFinish(): void {
    if (
      this.finished ||
      this.cancelled ||
      this.state === "done" ||
      this.state === "error" ||
      this.state === "cancelled"
    ) return;
    this.finished = true;
    this.wake();
  }

  async onCancel(reason?: string): Promise<void> {
    if (this.cancelled || this.state === "done" || this.state === "error") return;
    this.cancelled = true;
    this.state = "cancelled";
    this.wake();

    if (reason !== "release_state") {
      const msg: MsgEncodeCancelled = { type: "encode_cancelled", sessionId: this.sessionId };
      this.port.postMessage(msg);
    }
    this.endSessionOnce();
    void this.disposeActiveEncoder(reason, true);
  }

  private async run(): Promise<void> {
    const codec = this.backend.module as NodeCodecModule;
    const encOpts: any = {
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
    };
    if (this.opts.progressiveDc != null) encOpts.progressiveDc = this.opts.progressiveDc;
    if (this.opts.progressiveAc != null) encOpts.progressiveAc = this.opts.progressiveAc;
    if (this.opts.qProgressiveAc != null) encOpts.qProgressiveAc = this.opts.qProgressiveAc;
    if (this.opts.groupOrder != null) encOpts.groupOrder = this.opts.groupOrder;
    const encoder = codec.createEncoder(encOpts);
    this.encoder = encoder;
    this.state = "configured";

    try {
      await Promise.all([this.feedEncoder(encoder), this.readEncoderChunks(encoder)]);
    } finally {
      await this.disposeActiveEncoder();
    }
  }

  private wake(): void {
    const resolve = this.wakeResolve;
    if (resolve === null) return;
    this.wakeResolve = null;
    resolve();
  }

  private endSessionOnce(): void {
    if (this.ended) return;
    this.ended = true;
    this.clearPixelQueue();
    this.callbacks.onSessionEnd(this.sessionId);
  }

  private clearPixelQueue(): void {
    this.pixelQueue.length = 0;
    this.pixelReadIndex = 0;
    this.queueDepth = 0;
    this.queuedBytes = 0;
  }

  private disposeActiveEncoder(reason?: string, cancelFirst = false): Promise<void> {
    if (this.disposePromise !== null) return this.disposePromise;
    const encoder = this.encoder;
    if (encoder === null) return Promise.resolve();
    this.encoder = null;
    this.disposePromise = (async () => {
      if (cancelFirst) {
        try {
          await encoder.cancel(reason);
        } catch {
          // Best-effort cleanup.
        }
      }
      try {
        await encoder.dispose();
      } catch {
        // Best-effort cleanup.
      }
    })();
    return this.disposePromise;
  }

  private waitForPixels(): Promise<void> {
    if (this.pixelQueue.length > this.pixelReadIndex || this.finished || this.cancelled
        || this.state === "done" || this.isErrored()) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => { this.wakeResolve = resolve; });
  }

  private takeNextPixels(): { chunk: Buffer; region?: Region } | null {
    const entry = this.pixelQueue[this.pixelReadIndex];
    this.pixelQueue[this.pixelReadIndex++] = undefined;
    if (entry === undefined) {
      this.compactQueue();
      return null;
    }
    this.queueDepth--;
    this.queuedBytes -= entry.chunk.byteLength;
    this.compactQueue();
    return entry;
  }

  private compactQueue(): void {
    if (this.pixelReadIndex >= this.pixelQueue.length) {
      this.pixelQueue.length = 0;
      this.pixelReadIndex = 0;
    } else if (this.pixelReadIndex > 64 && this.pixelReadIndex * 2 > this.pixelQueue.length) {
      this.pixelQueue.copyWithin(0, this.pixelReadIndex);
      this.pixelQueue.length -= this.pixelReadIndex;
      this.pixelReadIndex = 0;
    }
  }

  private async feedEncoder(encoder: NodeEncoder): Promise<void> {
    while (!this.cancelled && this.state !== "done" && !this.isErrored()) {
      await this.waitForPixels();
      while (this.pixelQueue.length > this.pixelReadIndex) {
        const entry = this.takeNextPixels();
        if (entry === null) break;
        if (this.cancelled || this.isErrored()) return;
        await encoder.pushPixels(entry.chunk, entry.region);
        if (this.cancelled || this.isErrored()) return;
        this.maybePostDrain();
      }
      if (this.finished) {
        if (this.cancelled || this.isErrored()) return;
        this.state = "finalising";
        await encoder.finish();
        return;
      }
    }
  }

  private maybePostDrain(): void {
    const drainAllowed = this.queueDepth < CHUNK_HWM;
    const crossedIntoDrain = drainAllowed && !this.lastDrainAllowed;
    this.lastDrainAllowed = drainAllowed;

    if (!drainAllowed) return;

    const now = performance.now();
    const intervalElapsed = now - this.lastDrainPostedMs >= DRAIN_MIN_INTERVAL_MS;

    if (!crossedIntoDrain && !intervalElapsed) return;

    this.lastDrainPostedMs = now;
    this.port.postMessage({
      type: "worker_drain",
      sessionId: this.sessionId,
      latencyMs: 0,
      queueDepth: this.queueDepth,
      queuedBytes: this.queuedBytes,
      adaptiveHwm: CHUNK_HWM,
    });
  }

  private isErrored(): boolean {
    return this.state === "error";
  }

  private async readEncoderChunks(encoder: NodeEncoder): Promise<void> {
    let totalBytes = 0;
    let chunkIndex = 0;
    const sidecarCount = this.opts.sidecarSizes?.length ?? 0;
    const sidecarOffsets: number[] = [];
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
      if (chunkIndex < sidecarCount) {
        sidecarOffsets.push(totalBytes);
      }
      chunkIndex++;
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
      ...(sidecarOffsets.length > 0 ? { sidecarOffsets } : {}),
    };
    this.port.postMessage(doneMsg);
    this.endSessionOnce();
  }

  private failSession(code: string, message: string): void {
    if (this.cancelled || this.state === "done" || this.state === "error") return;
    this.state = "error";
    // Unblock feedEncoder if it's sleeping in waitForPixels — mirrors browser handler.
    this.wake();
    const msg: MsgEncodeError = { type: "encode_error", sessionId: this.sessionId, code, message };
    this.port.postMessage(msg);
    this.endSessionOnce();
    void this.disposeActiveEncoder();
  }
}

function toBuffer(value: ArrayBuffer | Uint8Array | Buffer): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}
