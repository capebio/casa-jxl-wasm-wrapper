// jxl-worker-node/src/decode-handler.ts
// Decode session handler for node:worker_threads.
// Same protocol as jxl-worker-browser/decode-handler.ts.
// BLOCKED on T-NATIVE-BIND + T-DECODE-NATIVE for real codec calls.

import type { MessagePort } from "node:worker_threads";
import type { Backend } from "./backend-selector.js";
import type {
  MsgDecodeStart,
  MsgDecodeHeader,
  MsgDecodeError,
  MsgDecodeCancelled,
} from "@casabio/jxl-core/protocol";
import type { ImageInfo, DecodeStage } from "@casabio/jxl-core/types";

type DecodeState = "created" | "headers" | "progressive" | "final" | "cancelled" | "error" | "budget_exceeded";

interface DecodeHandlerCallbacks {
  onSessionEnd: (sessionId: string) => void;
  port: MessagePort;
}

const CHUNK_HWM = 4;

export class DecodeHandler {
  private readonly sessionId: string;
  private readonly opts: MsgDecodeStart;
  private readonly backend: Backend;
  private readonly port: MessagePort;
  private readonly callbacks: DecodeHandlerCallbacks;

  private state: DecodeState = "created";
  private chunkQueue: Buffer[] = [];
  private queueDepth = 0;
  private cancelled = false;
  private inputClosed = false;

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
    this.state = "cancelled";

    const msg: MsgDecodeCancelled = { type: "decode_cancelled", sessionId: this.sessionId };
    this.port.postMessage(msg);
    this.callbacks.onSessionEnd(this.sessionId);
  }

  private async run(): Promise<void> {
    // STUB: real impl provided by T-DECODE-NATIVE.
    //
    // Real flow for native backend:
    //   Same event loop as T-DECODE-WASM but calling jxl-native C++ binding directly.
    //   Emit Buffer on output side (not ArrayBuffer) per spec Section 15.2.
    //
    // Real flow for wasm backend:
    //   Same as jxl-worker-browser/decode-handler.ts but in Node environment.

    await this.waitForChunk();
    if (this.cancelled) return;

    this.state = "headers";
    const stubInfo: ImageInfo = {
      width: 0, height: 0, bitsPerSample: 8,
      hasAlpha: false, hasAnimation: false, jpegReconstructionAvailable: false,
    };
    const headerMsg: MsgDecodeHeader = {
      type: "decode_header", sessionId: this.sessionId, info: stubInfo,
    };
    this.port.postMessage(headerMsg);

    if (this.opts.progressionTarget === "header") {
      this.state = "final";
      this.callbacks.onSessionEnd(this.sessionId);
      return;
    }

    this.failSession("Internal", "[jxl-worker-node] decode stub: awaiting T-DECODE-NATIVE.");
  }

  private waitForChunk(): Promise<void> {
    return new Promise<void>((resolve) => {
      const check = () => {
        if (this.chunkQueue.length > 0 || this.inputClosed || this.cancelled) {
          resolve();
        } else {
          setTimeout(check, 2);
        }
      };
      check();
    });
  }

  private failSession(code: string, message: string): void {
    if (this.cancelled || this.state === "final") return;
    this.state = "error";
    const msg: MsgDecodeError = { type: "decode_error", sessionId: this.sessionId, code, message };
    this.port.postMessage(msg);
    this.callbacks.onSessionEnd(this.sessionId);
  }
}
