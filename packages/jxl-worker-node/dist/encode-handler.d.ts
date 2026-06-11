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
    private pixelReadIndex;
    private queueDepth;
    private queuedBytes;
    private cancelled;
    private finished;
    private ended;
    private firstByteEmitted;
    private wakeResolve;
    private lastDrainPostedMs;
    private lastDrainAllowed;
    private encoder;
    private disposePromise;
    constructor(opts: MsgEncodeStart, backend: Backend, callbacks: EncodeHandlerCallbacks);
    onPixels(chunk: ArrayBuffer | Uint8Array | Buffer, region?: Region): void;
    onFinish(): void;
    onCancel(reason?: string): Promise<void>;
    private run;
    private wake;
    private endSessionOnce;
    private clearPixelQueue;
    private disposeActiveEncoder;
    private waitForPixels;
    private takeNextPixels;
    private compactQueue;
    private feedEncoder;
    private maybePostDrain;
    private isErrored;
    private readEncoderChunks;
    private failSession;
}
export {};
//# sourceMappingURL=encode-handler.d.ts.map