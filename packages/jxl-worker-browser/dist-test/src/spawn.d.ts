import type { MainToWorkerMessage, WorkerToMainMessage } from "@casabio/jxl-core/protocol";
export interface SpawnOptions {
    startupTimeoutMs?: number;
    name?: string;
}
export interface WorkerHandle {
    send(msg: MainToWorkerMessage, transfer?: Transferable[]): void;
    onMessage(handler: (msg: WorkerToMainMessage) => void): void;
    shutdown(timeoutMs?: number): Promise<void>;
    readonly terminated: boolean;
    /** Register a callback fired once if the worker dies after startup
     *  (uncaught error or unreadable message). The pool should recycle the slot. */
    onCrash(handler: (reason: string) => void): void;
}
export declare function spawnWorker(workerUrl?: string, opts?: SpawnOptions): Promise<WorkerHandle>;
//# sourceMappingURL=spawn.d.ts.map