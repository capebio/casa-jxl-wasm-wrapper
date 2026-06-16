import type { MainToWorkerMessage, WorkerToMainMessage } from "@casabio/jxl-core/protocol";
export interface WorkerHandle {
    send(msg: MainToWorkerMessage, transfer?: unknown[]): void;
    onMessage(handler: (msg: WorkerToMainMessage) => void): void;
    shutdown(timeoutMs?: number): Promise<void>;
    readonly terminated: boolean;
}
export interface SpawnWorkerOptions {
    readyTimeoutMs?: number;
    resourceLimits?: {
        maxYoungGenerationSizeMb?: number;
        maxOldGenerationSizeMb?: number;
        codeRangeSizeMb?: number;
        stackSizeMb?: number;
    };
    env?: Record<string, string | undefined>;
    execArgv?: string[];
}
export declare function spawnWorker(options?: SpawnWorkerOptions): Promise<WorkerHandle>;
//# sourceMappingURL=spawn.d.ts.map