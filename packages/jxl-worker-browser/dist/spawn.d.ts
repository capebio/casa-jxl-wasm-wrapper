import type { MainToWorkerMessage, WorkerToMainMessage } from "@casabio/jxl-core/protocol";
export interface WorkerHandle {
    send(msg: MainToWorkerMessage, transfer?: Transferable[]): void;
    onMessage(handler: (msg: WorkerToMainMessage) => void): void;
    shutdown(timeoutMs?: number): Promise<void>;
    readonly terminated: boolean;
}
export declare function spawnWorker(workerUrl?: string): Promise<WorkerHandle>;
//# sourceMappingURL=spawn.d.ts.map