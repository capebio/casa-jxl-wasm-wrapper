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
    private queueDepth;
    private cancelled;
    private finished;
    private firstByteEmitted;
    constructor(opts: MsgEncodeStart, wasm: JxlModule, callbacks: EncodeHandlerCallbacks);
    onPixels(chunk: ArrayBuffer, region?: Region): void;
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