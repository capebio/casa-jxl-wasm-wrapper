// jxl-scheduler/src/types.ts
// Scheduler-internal types. Not part of the public jxl-core contract.

import type { WorkerToMainMessage, MainToWorkerMessage } from "@casabio/jxl-core/protocol";

export type Priority = "visible" | "near" | "background";

// A live or queued session with all its metadata.
export interface Session {
  sessionId: string;
  priority: Priority;
  // Source identity for dedupe. null if no identity provided.
  sourceKey: string | null;
  // Resolve/reject for the "slot acquired" promise returned to the caller.
  // Null once the session is running.
  pendingResolve: (() => void) | null;
  pendingReject: ((err: unknown) => void) | null;
  // AbortSignal for external cancellation.
  signal: AbortSignal | null;
  // For deduped fan-out: list of subscriber session IDs that share this stream.
  subscribers: string[];
}

export type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

// A worker slot in the pool.
export interface PoolWorker {
  id: number;
  handle: WorkerHandle;
  // Current session bound to this worker, or null if idle.
  activeSessionId: string | null;
  // True while a cancel is in flight (decode_cancel sent, awaiting decode_cancelled).
  cancelling: boolean;
  idleTimer: TimerHandle | null;
}

// Minimal handle surface needed by scheduler. Implemented by jxl-worker-browser/spawn.ts
// and jxl-worker-node/spawn.ts.
export interface WorkerHandle {
  send(msg: MainToWorkerMessage, transfer?: ArrayBuffer[]): void;
  onMessage(handler: (msg: WorkerToMainMessage) => void): void;
  shutdown(timeoutMs?: number): Promise<void>;
  readonly terminated: boolean;
}

// Factory function the scheduler uses to create workers.
export type WorkerFactory = () => Promise<WorkerHandle>;
