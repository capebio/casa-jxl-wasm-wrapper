import type { MessagePort } from "node:worker_threads";
import type { Backend } from "./backend-selector.js";
import type { MsgDecodeStart } from "@casabio/jxl-core/protocol";
interface DecodeHandlerCallbacks {
    onSessionEnd: (sessionId: string) => void;
    port: MessagePort;
}
export declare class DecodeHandler {
    private readonly sessionId;
    private readonly opts;
    private readonly backend;
    private readonly port;
    private readonly callbacks;
    private state;
    private chunkQueue;
    private queueDepth;
    private cancelled;
    private inputClosed;
    constructor(opts: MsgDecodeStart, backend: Backend, callbacks: DecodeHandlerCallbacks);
    onChunk(chunk: ArrayBuffer | Uint8Array | Buffer): void;
    onClose(): void;
    onCancel(reason?: string): Promise<void>;
    private run;
    private waitForChunk;
    private failSession;
}
export {};
//# sourceMappingURL=decode-handler.d.ts.map