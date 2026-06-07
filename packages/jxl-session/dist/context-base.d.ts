import type { ContextOptions, DecodeOptions, DecodeSession, EncodeOptions, EncodeSession, Capabilities } from "@casabio/jxl-core";
import { type WorkerFactory } from "@casabio/jxl-scheduler";
export interface JxlContext {
    decode(opts: DecodeOptions): DecodeSession;
    encode(opts: EncodeOptions): EncodeSession;
    capabilities(): Capabilities;
    shutdown(): Promise<void>;
}
export declare function validateWasmUrl(url: string): void;
export declare function hardwareConcurrency(): number;
export declare class JxlContextImpl implements JxlContext {
    private readonly scheduler;
    private caps;
    private shuttingDown;
    private probeSettled;
    constructor(factory: WorkerFactory, opts: ContextOptions | undefined, maxWorkers: number);
    probeCapabilities(): void;
    decode(opts: DecodeOptions): DecodeSession;
    encode(opts: EncodeOptions): EncodeSession;
    capabilities(): Capabilities;
    shutdown(): Promise<void>;
}
//# sourceMappingURL=context-base.d.ts.map