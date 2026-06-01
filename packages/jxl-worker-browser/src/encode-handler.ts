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
const FINISH_TIMEOUT_MS = 30_000;

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
  private sessionEnded = false;
  private firstByteEmitted = false;
  private wakeResolve: (() => void) | null = null;
  private lastDrainPostedMs = 0;
  private lastDrainAllowed = false;

  // Pre-allocated message objects — mutated in-place before postMessage (safe: structured clone is synchronous).
  private readonly _drainMsg = {
    type: "worker_drain" as const,
    sessionId: "" as string,
    latencyMs: 0,
    queueDepth: 0,
    queuedBytes: 0,
    adaptiveHwm: CHUNK_HWM,
  };
  private readonly _chunkMsg: MsgEncodeChunk = {
    type: "encode_chunk",
    sessionId: "" as string,
    chunk: new ArrayBuffer(0),
  };

  constructor(
    opts: MsgEncodeStart,
    wasm: JxlModule,
    callbacks: EncodeHandlerCallbacks,
  ) {
    this.sessionId = opts.sessionId;
    this.opts = opts;
    this.wasm = wasm;
    this.callbacks = callbacks;

    this._drainMsg.sessionId = this.sessionId;
    this._chunkMsg.sessionId = this.sessionId;

    this.run().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.failSession("Internal", message);
    });
  }

  // ---------------------------------------------------------------------------
  // Incoming message handlers
  // ---------------------------------------------------------------------------

  onPixels(chunk: ArrayBuffer, region?: Region): void {
    if (this.cancelled || this.state === "done") return;
    const entry = region !== undefined ? { chunk, region } : { chunk };
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
    // Do NOT call onSessionEnd here — run()'s finally block is responsible.
  }

  // ---------------------------------------------------------------------------
  // Main encode loop
  // ---------------------------------------------------------------------------

  private async run(): Promise<void> {
    // Cast to unknown first to allow passing progressiveFlavor which is not yet
    // declared in the JxlModule.createEncoder interface in wasm-loader.ts.
    const encoderOpts = {
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
      // progressiveFlavor is present in protocol.ts but missing from the stale
      // node_modules copy of jxl-core — cast to access it safely.
      progressiveFlavor: (this.opts as MsgEncodeStart & { progressiveFlavor?: "dc" | "ac" }).progressiveFlavor,
      previewFirst: this.opts.previewFirst,
      chunked: this.opts.chunked,
      sidecarSizes: this.opts.sidecarSizes,
    } as Parameters<JxlModule["createEncoder"]>[0];
    const encoder = this.wasm.createEncoder(encoderOpts);
    this.state = "configured";
    try {
      await Promise.all([this.feedEncoder(encoder), this.readEncoderChunks(encoder)]);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.failSession("Internal", message);
    } finally {
      await encoder.dispose();
      this.endSession();
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private endSession(): void {
    if (this.sessionEnded) return;
    this.sessionEnded = true;
    this.callbacks.onSessionEnd(this.sessionId);
  }

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
        // Re-check state after async pushPixels — cancellation or error may have arrived.
        // Cast through string to defeat TypeScript's pre-await control-flow narrowing.
        const stateAfterPush = this.state as string;
        if (this.cancelled || stateAfterPush === "done" || stateAfterPush === "error") return;
        this.maybePostDrain();
      }
      if (this.finished) {
        // Re-check state before calling finish — guard against race with onCancel.
        const stateAfterWait = this.state as string;
        if (this.cancelled || stateAfterWait === "done" || stateAfterWait === "error") return;
        this.state = "finalising";
        await Promise.race([
          encoder.finish(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("encoder.finish() timed out after 30 s")), FINISH_TIMEOUT_MS),
          ),
        ]);
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

    this._drainMsg.queueDepth = this.queueDepth;
    self.postMessage(this._drainMsg);
  }

  private async readEncoderChunks(encoder: BrowserEncoder): Promise<void> {
    let totalBytes = 0;
    const sidecarCount = this.opts.sidecarSizes?.length ?? 0;
    const sidecarOffsets: number[] = [];
    let chunkIndex = 0;

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
      // Track cumulative byte position at each sidecar boundary.
      // Sidecar chunks are yielded first (one per sidecar), before the main image.
      if (chunkIndex < sidecarCount) {
        sidecarOffsets.push(totalBytes);
      }
      chunkIndex++;
      this._chunkMsg.chunk = buffer;
      this.state = "streaming";
      self.postMessage(this._chunkMsg, [buffer]);
    }

    if (this.cancelled || this.state === "done" || this.state === "error") return;
    this.state = "done";
    const doneMsg: MsgEncodeDone = {
      type: "encode_done",
      sessionId: this.sessionId,
      totalBytes,
      ...(sidecarOffsets.length > 0 ? { sidecarOffsets } : {}),
    };
    self.postMessage(doneMsg);
    // Do NOT call onSessionEnd here — run()'s finally block is responsible.
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
    // Do NOT call onSessionEnd here — run()'s finally block is responsible.
  }
}

function toArrayBuffer(value: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  return value.byteOffset === 0 && value.byteLength === value.buffer.byteLength
    ? value.buffer
    : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
}
