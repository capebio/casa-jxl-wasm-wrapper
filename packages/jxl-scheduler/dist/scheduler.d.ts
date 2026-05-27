import type { MainToWorkerMessage, WorkerToMainMessage, MsgDecodeStart, MsgEncodeStart } from "@casabio/jxl-core/protocol";
import type { Priority, WorkerFactory } from "./types.js";
export interface SchedulerOptions {
    factory: WorkerFactory;
    maxWorkers: number;
    idleTimeoutMs?: number;
    pushHwm?: number;
    prewarmSize?: number;
}
export interface SchedulerMetrics {
    /** Sessions currently assigned to a worker (includes cancelling). */
    running: number;
    /** Sessions waiting in the priority queue for a worker slot. */
    queued: number;
    /** Decode sessions paused on a worker, awaiting a resume slot. */
    paused: number;
    /** Running sessions with background priority. */
    background: number;
    /** Total preemptions performed since construction. */
    preemptions: number;
    /** Total sessions created since construction. */
    totalSessions: number;
}
export declare class Scheduler {
    private readonly pool;
    private readonly queue;
    private readonly dedupe;
    private readonly sessions;
    private readonly pendingHandlers;
    private readonly backgroundWorkers;
    private readonly workerPausedSession;
    private readonly wiredWorkers;
    private readonly pushHwm;
    private destroyed;
    private drainingQueue;
    private preemptionCount;
    private totalSessionCount;
    private readonly PREEMPT_PROGRESS_W;
    private readonly PREEMPT_AGE_W;
    private readonly PREEMPT_AGE_NORM_MS;
    private drainLatencyEma;
    private readonly DRAIN_EMA_ALPHA;
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
    private adaptiveHwm;
    private updateDrainEma;
    private unblockBackpressure;
    getMetrics(): SchedulerMetrics;
    private tryPreempt;
    private scoreVictim;
    private findBackgroundWorker;
    private resumePausedSession;
    private assignWorker;
    private ensureWorkerWired;
    private static readonly STAGE_PROGRESS;
    private handleWorkerMessage;
    private isTerminalMessage;
    private setupSignalAbort;
    private takePendingHandlers;
    private cleanupSession;
    private releaseSession;
    private drainQueue;
    shutdown(): Promise<void>;
}
//# sourceMappingURL=scheduler.d.ts.map