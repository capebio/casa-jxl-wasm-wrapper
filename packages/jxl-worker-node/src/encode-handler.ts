// jxl-worker-node/src/encode-handler.ts
// Encode session handler for node:worker_threads.
// BLOCKED on T-NATIVE-BIND + T-ENCODE-NATIVE for real codec calls.

import type { MessagePort } from "node:worker_threads";
import type { Backend } from "./backend-selector.js";
import type {
  MsgEncodeStart,
  MsgEncodeError,
  MsgEncodeCancelled,
} from "@casabio/jxl-core/protocol";
import type { Region } from "@casabio/jxl-core/types";

type EncodeState = "created" | "configured" | "streaming" | "finalising" | "done" | "cancelled" | "error";

interface EncodeHandlerCallbacks {
  onSessionEnd: (sessionId: string) => void;
  port: MessagePort;
}

export class EncodeHandler {
  private readonly sessionId: string;
  private readonly opts: MsgEncodeStart;
  private readonly backend: Backend;
  private readonly port: MessagePort;
  private readonly callbacks: EncodeHandlerCallbacks;

  private state: EncodeState = "created";
  private pixelQueue: Array<{ chunk: Buffer; region?: Region }> = [];
  private cancelled = false;
  private finished = false;

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
    // STUB: real impl provided by T-ENCODE-NATIVE.

    await this.waitForPixels();
    if (this.cancelled) return;

    this.failSession("Internal", "[jxl-worker-node] encode stub: awaiting T-ENCODE-NATIVE.");
  }

  private waitForPixels(): Promise<void> {
    return new Promise<void>((resolve) => {
      const check = () => {
        if (this.pixelQueue.length > 0 || this.finished || this.cancelled) resolve();
        else setTimeout(check, 2);
      };
      check();
    });
  }

  private failSession(code: string, message: string): void {
    if (this.cancelled || this.state === "done") return;
    this.state = "error";
    const msg: MsgEncodeError = { type: "encode_error", sessionId: this.sessionId, code, message };
    this.port.postMessage(msg);
    this.callbacks.onSessionEnd(this.sessionId);
  }
}
