import type { JxlModule } from "./wasm-loader.js";
import type { MsgEncodeStart } from "@casabio/jxl-core/protocol";
import type { Region } from "@casabio/jxl-core/types";
interface EncodeHandlerCallbacks {
    onSessionEnd: (sessionId: string) => void;
}
export declare class EncodeHandler {
    private readonly sessionId;
    private readonly opts;
    private readonly wasm;
    private readonly callbacks;
    private state;
    private pixelQueue;
    private pixelReadIndex;
    private queueDepth;
    private queuedBytes;
    private cancelled;
    private finished;
    private sessionEnded;
    private firstByteEmitted;
    private wakeResolve;
    private lastDrainPostedMs;
    private lastDrainAllowed;
    private encoder;
    private disposePromise;
    private readonly _drainMsg;
    private readonly _chunkMsg;
    constructor(opts: MsgEncodeStart, wasm: JxlModule, callbacks: EncodeHandlerCallbacks);
    onPixels(chunk: ArrayBuffer, region?: Region): void;
    onFinish(): void;
    onCancel(reason?: string): Promise<void>;
    private run;
    private finishSession;
    private isTerminal;
    private clearPixelQueue;
    private wake;
    private disposeActiveEncoder;
    private waitForPixels;
    private takeNextPixels;
    private compactQueue;
    private feedEncoder;
    private maybePostDrain;
    private readEncoderChunks;
    private failSession;
}
export {};
//# sourceMappingURL=encode-handler.d.ts.map