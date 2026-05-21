import type { PoolWorker, WorkerFactory } from "./types.js";
export declare class WorkerPool {
    private readonly factory;
    private readonly maxSize;
    private readonly idleTimeoutMs;
    private readonly workers;
    private destroyed;
    constructor(opts: {
        factory: WorkerFactory;
        maxSize: number;
        idleTimeoutMs: number;
    });
    get size(): number;
    get idleWorkers(): PoolWorker[];
    get activeWorkers(): PoolWorker[];
    acquire(): Promise<PoolWorker | null>;
    spawn(): Promise<PoolWorker>;
    bind(worker: PoolWorker, sessionId: string): void;
    release(worker: PoolWorker): void;
    recycle(worker: PoolWorker): void;
    private reap;
    private clearIdleTimer;
    private destroyWorker;
    shutdown(): Promise<void>;
}
//# sourceMappingURL=pool.d.ts.map