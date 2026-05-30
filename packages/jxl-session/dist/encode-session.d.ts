import type { EncodeOptions, EncodeSession, EncodeStats, Region } from "@casabio/jxl-core";
import type { Scheduler } from "@casabio/jxl-scheduler";
export declare class EncodeSessionImpl implements EncodeSession {
    readonly id: string;
    private readonly scheduler;
    private readonly opts;
    private readonly chunkStream;
    private readonly doneDeferred;
    private readonly acquirePromise;
    private readonly abortSignal;
    private readonly abortHandler;
    private finished;
    private terminated;
    private totalBytesWritten;
    constructor(scheduler: Scheduler, opts: EncodeOptions);
    pushPixels(chunk: ArrayBuffer, region?: Region): Promise<void>;
    finish(): Promise<void>;
    chunks(): AsyncIterable<ArrayBuffer>;
    done(): Promise<number>;
    getStats(): EncodeStats | null;
    cancel(reason?: string): Promise<void>;
    private handleMessage;
    private cleanup;
    private complete;
    private terminate;
    private normalizeCode;
}
//# sourceMappingURL=encode-session.d.ts.map