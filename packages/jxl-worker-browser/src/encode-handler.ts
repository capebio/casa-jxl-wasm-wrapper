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
const MAX_QUEUED_BYTES = 128 * 1024 * 1024;

export class EncodeHandler {
  private readonly sessionId: string;
  private readonly opts: MsgEncodeStart;
  private readonly wasm: JxlModule;
  private readonly callbacks: EncodeHandlerCallbacks;

  private state: EncodeState = "created";
  private pixelQueue: Array<{ chunk: ArrayBuffer; region?: Region } | undefined> = [];
  private pixelReadIndex = 0;
  private queueDepth = 0;
  private queuedBytes = 0;
  private cancelled = false;
  private finished = false;
  private sessionEnded = false;
  private firstByteEmitted = false;
  private wakeResolve: (() => void) | null = null;
  private lastDrainPostedMs = 0;
  private lastDrainAllowed = false;
  private encoder: BrowserEncoder | null = null;
  private disposePromise: Promise<void> | null = null;

  // Profiling hooks (accumulated, posted as metrics at key points + end)
  private readonly stageStartMs = performance.now();
  private createEncoderMs = 0;
  private totalWaitForPixelsMs = 0;
  private totalPushPixelsMs = 0;
  private finishMs = 0;
  private totalChunkYieldMs = 0;
  private firstByteMs = 0;
  private lastPushStart = 0;

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
    if (this.isTerminal() || this.finished) return;
    if (this.queuedBytes + chunk.byteLength > MAX_QUEUED_BYTES) {
      this.failSession("QueueOverflow", `Encode input queue exceeded ${MAX_QUEUED_BYTES >> 20} MiB`);
      return;
    }
    const entry = region !== undefined ? { chunk, region } : { chunk };
    this.pixelQueue.push(entry);
    this.queueDepth++;
    this.queuedBytes += chunk.byteLength;
    this.wake();
  }

  onFinish(): void {
    if (this.isTerminal() || this.finished) return;
    this.finished = true;
    this.wake();
  }

  async onCancel(reason?: string): Promise<void> {
    if (this.sessionEnded || this.cancelled) return;
    this.cancelled = true;
    if (reason !== "release_state") {
      const msg: MsgEncodeCancelled = {
        type: "encode_cancelled",
        sessionId: this.sessionId,
      };
      self.postMessage(msg);
    }
    this.finishSession("cancelled");
    void this.disposeActiveEncoder(reason, true);
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
      // progressiveDc + groupOrder (predator progressive layers + Tauri parity): forwarded so high-level session.encode
      // can produce files with >1 DC layer and center-out for the gallery/paint benchmarks and Tauri parity.
      progressiveDc: (this.opts as MsgEncodeStart).progressiveDc,
      progressiveAc: (this.opts as MsgEncodeStart).progressiveAc,
      qProgressiveAc: (this.opts as MsgEncodeStart).qProgressiveAc,
      groupOrder: (this.opts as MsgEncodeStart).groupOrder,
      chunked: this.opts.chunked,
      sidecarSizes: this.opts.sidecarSizes,
      // EXIF orientation (1..8). When set, JXL records rotation as metadata instead of rotating pixels.
      orientation: (this.opts as MsgEncodeStart).orientation,
      centerX: (this.opts as MsgEncodeStart).centerX,
      centerY: (this.opts as MsgEncodeStart).centerY,
      intrinsicSize: (this.opts as MsgEncodeStart).intrinsicSize,
      disablePerceptualHeuristics: (this.opts as MsgEncodeStart).disablePerceptualHeuristics,
      codestreamLevel: (this.opts as MsgEncodeStart).codestreamLevel,
      copyInput: false,
    } as Parameters<JxlModule["createEncoder"]>[0];
    const tCreate0 = performance.now();
    const encoder = this.wasm.createEncoder(encoderOpts);
    this.createEncoderMs = performance.now() - tCreate0;
    this.postMetric("encode_create_ms", this.createEncoderMs);
    this.encoder = encoder;
    this.state = "configured";
    try {
      await Promise.all([this.feedEncoder(encoder), this.readEncoderChunks(encoder)]);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.failSession("Internal", message);
    } finally {
      await this.disposeActiveEncoder();
      this.finishSession(this.state);
      this.postFinalMetrics();
    }
  }

  private postFinalMetrics(): void {
    const total = performance.now() - this.stageStartMs;
    this.postMetric("encode_total_ms", total);
    this.postMetric("encode_create_ms", this.createEncoderMs);
    this.postMetric("encode_push_pixels_ms", this.totalPushPixelsMs);
    this.postMetric("encode_wait_pixels_ms", this.totalWaitForPixelsMs);
    this.postMetric("encode_finish_ms", this.finishMs);
    this.postMetric("encode_chunk_yield_ms", this.totalChunkYieldMs);
    if (this.firstByteMs > 0) this.postMetric("encode_time_to_first_byte_ms", this.firstByteMs);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private finishSession(state: EncodeState): boolean {
    if (this.sessionEnded) return false;
    this.state = state;
    this.sessionEnded = true;
    this.clearPixelQueue();
    this.wake();
    this.callbacks.onSessionEnd(this.sessionId);
    return true;
  }

  private isTerminal(): boolean {
    return this.sessionEnded;
  }

  private clearPixelQueue(): void {
    this.pixelQueue.length = 0;
    this.pixelReadIndex = 0;
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

  private disposeActiveEncoder(reason?: string, cancelFirst = false): Promise<void> {
    if (this.disposePromise !== null) return this.disposePromise;
    const encoder = this.encoder;
    if (encoder === null) return Promise.resolve();
    this.encoder = null;
    this.disposePromise = (async () => {
      if (cancelFirst) {
        try {
          await encoder.cancel(reason);
        } catch (e) {
          console.error("[jxl-worker] encoder.cancel failed:", e);
        }
      }
      try {
        await encoder.dispose();
      } catch (e) {
        console.error("[jxl-worker] encoder.dispose failed:", e);
      }
    })();
    return this.disposePromise;
  }

  private waitForPixels(): Promise<void> {
    if (this.pixelQueue.length > this.pixelReadIndex || this.finished || this.isTerminal()) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => { this.wakeResolve = resolve; });
  }

  private takeNextPixels(): { chunk: ArrayBuffer; region?: Region } | null {
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

  private async feedEncoder(encoder: BrowserEncoder): Promise<void> {
    while (!this.isTerminal()) {
      const waitStart = performance.now();
      await this.waitForPixels();
      this.totalWaitForPixelsMs += performance.now() - waitStart;

      while (this.pixelQueue.length > this.pixelReadIndex) {
        const entry = this.takeNextPixels();
        if (entry === null) break;

        const pushStart = performance.now();
        await encoder.pushPixels(entry.chunk, entry.region);
        this.totalPushPixelsMs += performance.now() - pushStart;

        // Re-check state after async pushPixels — cancellation or error may have arrived.
        // Cast through string to defeat TypeScript's pre-await control-flow narrowing.
        if (this.isTerminal()) return;
        this.maybePostDrain();
      }
      if (this.finished) {
        // Re-check state before calling finish — guard against race with onCancel.
        if (this.isTerminal()) return;
        this.state = "finalising";
        const finStart = performance.now();
        await Promise.race([
          encoder.finish(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("encoder.finish() timed out after 30 s")), FINISH_TIMEOUT_MS),
          ),
        ]);
        this.finishMs = performance.now() - finStart;
        this.postMetric("encode_finish_ms", this.finishMs);
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
    this._drainMsg.queuedBytes = this.queuedBytes;
    self.postMessage(this._drainMsg);
  }

  private postMetric(name: string, value: number): void {
    self.postMessage({
      type: "metric",
      sessionId: this.sessionId,
      metric: { name, value },
    });
  }

  private async readEncoderChunks(encoder: BrowserEncoder): Promise<void> {
    let totalBytes = 0;
    const sidecarCount = this.opts.sidecarSizes?.length ?? 0;
    const sidecarOffsets: number[] = [];
    let chunkIndex = 0;

    for await (const chunk of encoder.chunks()) {
      if (this.isTerminal()) return;
      const tChunk0 = performance.now();
      const buffer = toArrayBuffer(chunk);
      const chunkYieldMs = performance.now() - tChunk0;
      this.totalChunkYieldMs += chunkYieldMs;

      if (!this.firstByteEmitted) {
        this.firstByteEmitted = true;
        this.firstByteMs = performance.now() - this.stageStartMs;
        this.postMetric("encode_time_to_first_byte_ms", this.firstByteMs);
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

    if (this.isTerminal()) return;
    this.state = "done";
    this.postMetric("encode_chunk_yield_total_ms", this.totalChunkYieldMs);
    this.postMetric("encode_output_bytes", totalBytes);

    const doneMsg: MsgEncodeDone = {
      type: "encode_done",
      sessionId: this.sessionId,
      totalBytes,
      ...(sidecarOffsets.length > 0 ? { sidecarOffsets } : {}),
    };
    self.postMessage(doneMsg);
    this.finishSession("done");
    // final summary post already in finally via postFinalMetrics
  }

  private failSession(code: string, message: string): void {
    if (this.isTerminal()) return;

    const msg: MsgEncodeError = {
      type: "encode_error",
      sessionId: this.sessionId,
      code,
      message,
    };
    self.postMessage(msg);
    this.finishSession("error");
    void this.disposeActiveEncoder();
  }
}

function toArrayBuffer(value: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  return value.byteOffset === 0 && value.byteLength === value.buffer.byteLength
    ? value.buffer as ArrayBuffer
    : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}
