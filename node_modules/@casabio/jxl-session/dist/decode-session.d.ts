import type { DecodeOptions, DecodeSession, DecodeFrameEvent, ImageInfo } from "@casabio/jxl-core";
import type { Scheduler } from "@casabio/jxl-scheduler";
export declare class DecodeSessionImpl implements DecodeSession {
    readonly id: string;
    private readonly scheduler;
    private readonly opts;
    private readonly frameStream;
    private readonly doneDeferred;
    private readonly acquirePromise;
    private readonly abortSignal;
    private readonly abortHandler;
    private lastInfo;
    private closed;
    private terminated;
    constructor(scheduler: Scheduler, opts: DecodeOptions);
    push(chunk: ArrayBuffer | Uint8Array): Promise<void>;
    close(): Promise<void>;
    frames(): AsyncIterable<DecodeFrameEvent>;
    done(): Promise<ImageInfo>;
    cancel(reason?: string): Promise<void>;
    private handleMessage;
    private cleanup;
    private finish;
    private finishWithError;
    private fail;
    private normalizeCode;
}
//# sourceMappingURL=decode-session.d.ts.map