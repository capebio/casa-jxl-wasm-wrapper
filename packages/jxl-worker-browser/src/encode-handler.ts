// jxl-worker-browser/src/encode-handler.ts
// Encode session handler. Owns one libjxl encoder instance per session.
// Spec: Sections 11, 16.2.
//
// BLOCKED on T-WASM-BUILD + T-ENCODE-WASM for real codec calls.

/// <reference lib="webworker" />

import type { JxlModule } from "./wasm-loader.js";
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

export class EncodeHandler {
  private readonly sessionId: string;
  private readonly opts: MsgEncodeStart;
  private readonly wasm: JxlModule;
  private readonly callbacks: EncodeHandlerCallbacks;

  private state: EncodeState = "created";
  private pixelQueue: Array<{ chunk: ArrayBuffer; region?: Region }> = [];
  private queueDepth = 0;
  private cancelled = false;
  private finished = false;
  private firstByteEmitted = false;

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
  }

  onFinish(): void {
    this.finished = true;
  }

  async onCancel(reason?: string): Promise<void> {
    if (this.cancelled) return;
    this.cancelled = true;
    this.state = "cancelled";

    // STUB: call JxlEncoderDestroy in real impl.

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
    // STUB: real implementation provided by T-ENCODE-WASM.
    //
    // Real flow:
    //   1. Create JxlEncoder, configure JxlEncoderFrameSettings from opts.
    //   2. Map quality→distance via JxlEncoderDistanceFromQuality when needed.
    //   3. Attach iccProfile/exif/xmp boxes.
    //   4. For chunked: false — await finish(), then JxlEncoderAddImageFrame.
    //   5. For chunked: true — loop pixel queue, JxlEncoderAddChunkedFrame.
    //   6. Pump output via JxlEncoderSetOutputProcessor; emit encode_chunk.
    //   7. Emit encode_first_byte_ready on first output chunk.
    //   8. On done: emit encode_done with totalBytes.

    await this.waitForPixels();
    if (this.cancelled) return;

    this.state = "configured";

    this.failSession(
      "Internal",
      "[jxl-worker-browser] encode stub: awaiting T-ENCODE-WASM for real codec.",
    );
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private waitForPixels(): Promise<void> {
    return new Promise<void>((resolve) => {
      const check = () => {
        if (this.pixelQueue.length > 0 || this.finished || this.cancelled) {
          resolve();
        } else {
          setTimeout(check, 2);
        }
      };
      check();
    });
  }

  private failSession(code: string, message: string): void {
    if (this.cancelled || this.state === "done") return;
    this.state = "error";

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
