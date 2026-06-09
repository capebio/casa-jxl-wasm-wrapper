import type { WorkerToMainMessage, MainToWorkerMessage } from "@casabio/jxl-core/protocol";
export type Priority = "visible" | "near" | "background";
export interface Session {
    sessionId: string;
    priority: Priority;
    sourceKey: string | null;
    pendingResolve: (() => void) | null;
    pendingReject: ((err: unknown) => void) | null;
    signal: AbortSignal | null;
    subscribers: string[];
}
export type TimerHandle = ReturnType<typeof globalThis.setTimeout>;
export interface PoolWorker {
    id: number;
    handle: WorkerHandle;
    activeSessionId: string | null;
    cancelling: boolean;
    idleTimer: TimerHandle | null;
}
export interface WorkerHandle {
    send(msg: MainToWorkerMessage, transfer?: ArrayBuffer[]): void;
    onMessage(handler: (msg: WorkerToMainMessage) => void): void;
    shutdown(timeoutMs?: number): Promise<void>;
    readonly terminated: boolean;
}
export type WorkerFactory = () => Promise<WorkerHandle>;
export interface AdmissionGate {
    admit(sessionId: string, priority: Priority): Promise<() => void>;
}
//# sourceMappingURL=types.d.ts.map