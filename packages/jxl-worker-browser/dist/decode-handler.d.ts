import type { JxlModule } from "./wasm-loader.js";
import type { MsgDecodeStart } from "@casabio/jxl-core/protocol";
interface DecodeHandlerCallbacks {
    onSessionEnd: (sessionId: string) => void;
}
export declare class DecodeHandler {
    private readonly sessionId;
    private readonly opts;
    private readonly wasm;
    private readonly callbacks;
    private state;
    private chunkQueue;
    private queueDepth;
    private cancelled;
    private inputClosed;
    private stageStartMs;
    private currentStage;
    constructor(opts: MsgDecodeStart, wasm: JxlModule, callbacks: DecodeHandlerCallbacks);
    onChunk(chunk: ArrayBuffer): void;
    onClose(): void;
    onCancel(reason?: string): Promise<void>;
    private run;
    private waitForChunk;
    private feedDecoder;
    private readDecoderEvents;
    private checkBudget;
    private failSession;
    private postBudgetExceeded;
    private postMetric;
}
export {};
//# sourceMappingURL=decode-handler.d.ts.map