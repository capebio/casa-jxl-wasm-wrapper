import type { DecodeOptions, DecodeSession, DecodeFrameEvent, ImageInfo } from "@casabio/jxl-core";
import type { Scheduler } from "@casabio/jxl-scheduler";
export declare class DecodeSessionImpl implements DecodeSession {
    readonly id: string;
    private scheduler;
    private readonly opts;
    private readonly frameStream;
    private readonly doneDeferred;
    private readonly headerDeferred;
    private readonly acquirePromise;
    private readonly abortSignal;
    private readonly abortHandler;
    private lastInfo;
    private closed;
    private terminated;
    private framesConsumed;
    private terminalError;
    constructor(schedulerOrPromise: Scheduler | Promise<Scheduler>, opts: DecodeOptions);
    push(chunk: ArrayBuffer | Uint8Array): Promise<void>;
    close(): Promise<void>;
    /**
     * Returns the frame stream.
     * Contract (DS-2): call frames() BEFORE awaiting done() if you want to
     * observe progressive or final frames. If only done() is awaited (or frames()
     * called after done resolves), buffered frames may have been cleared and
     * will not be replayed.
     */
    frames(): AsyncIterable<DecodeFrameEvent>;
    /**
     * Awaits final ImageInfo (success) or rejects with JxlError.
     * See frames() contract: consume frames before done() to receive them.
     */
    done(): Promise<ImageInfo>;
    get info(): ImageInfo | null;
    header(): Promise<ImageInfo>;
    cancel(reason?: string): Promise<void>;
    private handleMessage;
    private cleanup;
    private finish;
    private finishWithError;
    private fail;
    private normalizeCode;
}
export declare function firstFrame(session: Pick<DecodeSession, "frames" | "cancel">, opts?: {
    minStage?: "dc" | "pass" | "final";
}): Promise<DecodeFrameEvent>;
//# sourceMappingURL=decode-session.d.ts.map