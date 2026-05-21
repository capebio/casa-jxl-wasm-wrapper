import type { MessagePort } from "node:worker_threads";
import type { Backend } from "./backend-selector.js";
import type { MsgEncodeStart } from "@casabio/jxl-core/protocol";
import type { Region } from "@casabio/jxl-core/types";
interface EncodeHandlerCallbacks {
    onSessionEnd: (sessionId: string) => void;
    port: MessagePort;
}
export declare class EncodeHandler {
    private readonly sessionId;
    private readonly opts;
    private readonly backend;
    private readonly port;
    private readonly callbacks;
    private state;
    private pixelQueue;
    private queueDepth;
    private cancelled;
    private finished;
    private firstByteEmitted;
    constructor(opts: MsgEncodeStart, backend: Backend, callbacks: EncodeHandlerCallbacks);
    onPixels(chunk: ArrayBuffer | Uint8Array | Buffer, region?: Region): void;
    onFinish(): void;
    onCancel(reason?: string): Promise<void>;
    private run;
    private waitForPixels;
    private feedEncoder;
    private readEncoderChunks;
    private failSession;
}
export {};
//# sourceMappingURL=encode-handler.d.ts.map