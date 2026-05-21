import type { MainToWorkerMessage, WorkerToMainMessage, MsgDecodeStart, MsgEncodeStart } from "@casabio/jxl-core/protocol";
import type { Priority, WorkerFactory } from "./types.js";
export interface SchedulerOptions {
    factory: WorkerFactory;
    maxWorkers: number;
    idleTimeoutMs?: number;
}
export declare class Scheduler {
    private readonly pool;
    private readonly queue;
    private readonly dedupe;
    private readonly sessionToWorker;
    private readonly workerToSession;
    private readonly messageHandlers;
    private readonly backpressure;
    private destroyed;
    constructor(opts: SchedulerOptions);
    acquireSlot(params: {
        sessionId: string;
        priority: Priority;
        startMsg: MsgDecodeStart | MsgEncodeStart;
        sourceKey: string | null;
        signal: AbortSignal | null;
    }): Promise<{
        workerId: number;
    }>;
    send(sessionId: string, msg: MainToWorkerMessage, transfer?: ArrayBuffer[]): void;
    onMessage(sessionId: string, handler: (msg: WorkerToMainMessage) => void): void;
    completeSession(sessionId: string): void;
    cancelSession(sessionId: string): boolean;
    waitForDrain(sessionId: string): Promise<void>;
    private signalDrain;
    private tryPreempt;
    private findBackgroundWorker;
    private readonly sessionPriority;
    private assignWorker;
    private handleWorkerMessage;
    private setupSignalAbort;
    private releaseSession;
    private drainQueue;
    private findQueuedSession;
    private getWorkerById;
    shutdown(): Promise<void>;
}
//# sourceMappingURL=scheduler.d.ts.map