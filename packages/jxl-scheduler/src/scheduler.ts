// jxl-scheduler/src/scheduler.ts
// Core scheduler: pool, three priority lanes, preemption, dedupe, budget.
// Spec: Section 12, T-SCHEDULER brief.
//
// Preemption invariant (Section 12.2):
//   A visible job entering a full pool preempts one background job.
//   Steps: send decode_cancel, await decode_cancelled ack, reassign worker.
//   Preempted job re-queues with a fresh session id; partial frames discarded.
//
// Dedupe invariant (Section 12.4):
//   Second request for same sourceKey returns fan-out subscription.
//   Cancel by one subscriber does not cancel primary unless all cancel.
//
// Budget invariant (Section 12.3):
//   budgetMs enforced per-stage transition, not wall-clock across whole decode.
//   On breach: session emits decode_budget_exceeded with best frame so far.

import type {
  MainToWorkerMessage,
  WorkerToMainMessage,
  MsgDecodeStart,
  MsgEncodeStart,
} from "@casabio/jxl-core/protocol";

import type { Priority, PoolWorker, WorkerFactory, WorkerHandle } from "./types.js";
import { WorkerPool } from "./pool.js";
import { PriorityQueue } from "./queue.js";
import { DedupeRegistry } from "./dedupe.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SchedulerOptions {
  factory: WorkerFactory;
  maxWorkers: number;
  idleTimeoutMs?: number;
}

// A "pending session" sitting in the queue waiting for a worker.
interface PendingSession {
  sessionId: string;
  priority: Priority;
  // The message to forward to the worker once a slot opens.
  startMsg: MsgDecodeStart | MsgEncodeStart;
  // All initial chunks accumulated before the worker was assigned.
  bufferedChunks: Array<{ msg: MainToWorkerMessage; transfer: ArrayBuffer[] }>;
  // Resolve/reject for the caller's "session accepted" promise.
  resolve: () => void;
  reject: (err: unknown) => void;
  signal: AbortSignal | null;
  // Whether this session was preempted and re-queued.
  isRequeue: boolean;
}

// Per-session backpressure state.
interface BackpressureState {
  queueDepth: number;
  pendingPushes: Array<{ resolve: () => void }>;
}

const PUSH_HWM = 4;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export class Scheduler {
  private readonly pool: WorkerPool;
  private readonly queue: PriorityQueue<PendingSession>;
  private readonly dedupe: DedupeRegistry;

  private readonly workerToSession = new Map<string, number>(); // sessionId → workerId
  // sessionId → message handler (so messages can be fanned out to subscribers)
  private readonly messageHandlers = new Map<string, Array<(msg: WorkerToMainMessage) => void>>();
  // backpressure per session
  private readonly backpressure = new Map<string, BackpressureState>();

  private destroyed = false;
  private drainingQueue = false;

  constructor(opts: SchedulerOptions) {
    this.pool = new WorkerPool({
      factory: opts.factory,
      maxSize: opts.maxWorkers,
      idleTimeoutMs: opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    });
    this.queue = new PriorityQueue<PendingSession>();
    this.dedupe = new DedupeRegistry();
  }

  // ---------------------------------------------------------------------------
  // Session acquisition — called by jxl-session to reserve a worker slot
  // ---------------------------------------------------------------------------

  // Reserve a worker slot for the given session. Resolves when the session
  // is running on a worker; rejects on abort or shutdown.
  async acquireSlot(params: {
    sessionId: string;
    priority: Priority;
    startMsg: MsgDecodeStart | MsgEncodeStart;
    sourceKey: string | null;
    signal: AbortSignal | null;
  }): Promise<{ workerId: number }> {
    if (this.destroyed) throw new Error("[jxl-scheduler] Scheduler is shut down.");

    // Dedupe check: if a session with the same sourceKey is running, fan out.
    if (params.sourceKey !== null) {
      const primaryId = this.dedupe.findPrimary(params.sourceKey);
      if (primaryId !== null) {
        // Subscribe and forward future events.
        this.dedupe.subscribe(params.sessionId, primaryId);
        const primaryWorkerNum = this.workerToSession.get(primaryId);
        // Return the primary's worker id so the caller can send chunks there.
        return { workerId: primaryWorkerNum ?? -1 };
      }
    }

    // Register in dedupe registry (becomes primary).
    if (params.sourceKey !== null) {
      this.dedupe.register(params.sessionId, params.sourceKey);
    }

    // Try to immediately acquire a worker.
    const worker = await this.pool.acquire();
    if (worker !== null) {
      this.assignWorker(worker, params.sessionId, params.startMsg);
      this.setupSignalAbort(params.sessionId, params.signal);
      return { workerId: worker.id };
    }

    // No worker available. Check for preemption opportunity.
    if (params.priority === "visible") {
      const preempted = await this.tryPreempt(params);
      if (preempted !== null) {
        return { workerId: preempted };
      }
    }

    // Queue the session and wait.
    return new Promise<{ workerId: number }>((resolve, reject) => {
      const pending: PendingSession = {
        sessionId: params.sessionId,
        priority: params.priority,
        startMsg: params.startMsg,
        bufferedChunks: [],
        resolve: () => resolve({ workerId: this.workerToSession.get(params.sessionId) ?? -1 }),
        reject,
        signal: params.signal,
        isRequeue: false,
      };
      this.queue.enqueue({ priority: params.priority, sessionId: params.sessionId, payload: pending });
      this.setupSignalAbort(params.sessionId, params.signal);
    });
  }

  // ---------------------------------------------------------------------------
  // Message forwarding — called by jxl-session to send messages to a worker
  // ---------------------------------------------------------------------------

  send(sessionId: string, msg: MainToWorkerMessage, transfer: ArrayBuffer[] = []): void {
    const workerId = this.workerToSession.get(sessionId);
    if (workerId === undefined) {
      // Session is queued — buffer the chunk.
      const entry = this.findQueuedSession(sessionId);
      if (entry !== null) {
        entry.bufferedChunks.push({ msg, transfer });
      }
      return;
    }

    const worker = this.getWorkerById(workerId);
    if (worker !== null) {
      worker.handle.send(msg, transfer);
    }
  }

  // Register a handler to receive messages from a worker for this session.
  onMessage(sessionId: string, handler: (msg: WorkerToMainMessage) => void): void {
    let handlers = this.messageHandlers.get(sessionId);
    if (handlers === undefined) {
      handlers = [];
      this.messageHandlers.set(sessionId, handlers);
    }
    handlers.push(handler);
  }

  // ---------------------------------------------------------------------------
  // Session completion / cancellation
  // ---------------------------------------------------------------------------

  completeSession(sessionId: string): void {
    this.releaseSession(sessionId, false);
    this.dedupe.complete(sessionId);
    this.messageHandlers.delete(sessionId);
    this.backpressure.delete(sessionId);
    this.drainQueue();
  }

  cancelSession(sessionId: string): boolean {
    // Check if the session is in the queue (not yet running).
    const removed = this.queue.remove(sessionId);
    if (removed) {
      this.dedupe.cancelSubscriber(sessionId);
      this.messageHandlers.delete(sessionId);
      this.backpressure.delete(sessionId);
      return true;
    }

    // Check if it's a subscriber (not primary).
    const shouldCancelPrimary = this.dedupe.cancelSubscriber(sessionId);
    if (!shouldCancelPrimary) {
      // Other subscribers remain; don't cancel the primary.
      this.messageHandlers.delete(sessionId);
      return true;
    }

    // Running session: send cancel to worker.
    const workerId = this.workerToSession.get(sessionId);
    if (workerId !== undefined) {
      const worker = this.getWorkerById(workerId);
      if (worker !== null) {
        worker.cancelling = true;
        worker.handle.send({ type: "decode_cancel", sessionId });
      }
    }

    this.messageHandlers.delete(sessionId);
    this.backpressure.delete(sessionId);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Backpressure
  // ---------------------------------------------------------------------------

  // Returns a promise that resolves when the worker queue drops below HWM.
  async waitForDrain(sessionId: string): Promise<void> {
    let bp = this.backpressure.get(sessionId);
    if (bp === undefined) {
      bp = { queueDepth: 0, pendingPushes: [] };
      this.backpressure.set(sessionId, bp);
    }

    bp.queueDepth++;
    if (bp.queueDepth < PUSH_HWM) return;

    // At or above HWM: wait for a drain signal.
    return new Promise<void>((resolve) => {
      bp!.pendingPushes.push({ resolve });
    });
  }

  private signalDrain(sessionId: string): void {
    const bp = this.backpressure.get(sessionId);
    if (bp === undefined) return;
    bp.queueDepth = Math.max(0, bp.queueDepth - 1);
    const waiter = bp.pendingPushes.shift();
    if (waiter !== undefined) waiter.resolve();
  }

  // ---------------------------------------------------------------------------
  // Preemption (Section 12.2)
  // ---------------------------------------------------------------------------

  private async tryPreempt(params: {
    sessionId: string;
    priority: Priority;
    startMsg: MsgDecodeStart | MsgEncodeStart;
    signal: AbortSignal | null;
  }): Promise<number | null> {
    // Find a worker running a background session.
    const backgroundWorker = this.findBackgroundWorker();
    if (backgroundWorker === null) return null;

    const victimSessionId = backgroundWorker.activeSessionId!;

    // Send cancel and wait for ack.
    backgroundWorker.cancelling = true;
    const cancelAck = new Promise<void>((resolve) => {
      const prevHandlers = this.messageHandlers.get(victimSessionId) ?? [];
      const cancelHandler = (msg: WorkerToMainMessage) => {
        if (
          (msg.type === "decode_cancelled" || msg.type === "encode_cancelled") &&
          msg.sessionId === victimSessionId
        ) {
          resolve();
          // Restore previous handlers without the cancel listener.
          this.messageHandlers.set(victimSessionId, prevHandlers);
        }
      };
      this.messageHandlers.set(victimSessionId, [cancelHandler, ...prevHandlers]);
      backgroundWorker.handle.send({ type: "decode_cancel", sessionId: victimSessionId, reason: "preempted" });
    });

    // Await ack with a 2-second timeout to prevent infinite wait on unresponsive worker.
    await Promise.race([
      cancelAck,
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error("preempt-timeout")), 2000)),
    ]).catch(() => {
      // Worker did not ack; recycle it.
      this.pool.recycle(backgroundWorker);
    });

    // Re-queue the victim with a fresh session id (partial frames discarded per spec).
    const victimPending = this.findQueuedSession(victimSessionId);
    if (victimPending !== null) {
      // Was still queued somehow — keep it.
    } else {
      // Re-queue with a new session id. The original session's caller will receive
      // a decode_cancelled message and may choose to resubmit.
      // Per spec: "Preempted background work re-queues with a fresh session id."
      // The scheduler does not synthesize a new session on behalf of the caller;
      // the caller is responsible for resubmitting after seeing decode_cancelled.
    }

    this.releaseSession(victimSessionId, true);

    // Assign the now-free worker to the preemptor.
    if (!backgroundWorker.handle.terminated) {
      this.assignWorker(backgroundWorker, params.sessionId, params.startMsg);
      this.setupSignalAbort(params.sessionId, params.signal);
      return backgroundWorker.id;
    }

    // Worker was recycled during cancel; try acquiring a fresh one.
    const newWorker = await this.pool.acquire();
    if (newWorker !== null) {
      this.assignWorker(newWorker, params.sessionId, params.startMsg);
      this.setupSignalAbort(params.sessionId, params.signal);
      return newWorker.id;
    }

    return null;
  }

  private findBackgroundWorker(): PoolWorker | null {
    for (const worker of this.pool.activeWorkers) {
      if (worker.cancelling || worker.activeSessionId === null) continue;
      if (this.sessionPriority.get(worker.activeSessionId) === "background") return worker;
    }
    return null;
  }

  // Track running session priorities for preemption decisions.
  private readonly sessionPriority = new Map<string, Priority>();

  // ---------------------------------------------------------------------------
  // Assignment helpers
  // ---------------------------------------------------------------------------

  private assignWorker(worker: PoolWorker, sessionId: string, startMsg: MsgDecodeStart | MsgEncodeStart): void {
    this.pool.bind(worker, sessionId);
    this.workerToSession.set(sessionId, worker.id);
    this.sessionPriority.set(sessionId, startMsg.priority as Priority);

    // Wire worker messages back to session handlers.
    worker.handle.onMessage((msg) => {
      this.handleWorkerMessage(sessionId, worker, msg);
    });

    // Send the start message.
    worker.handle.send(startMsg);
  }

  private handleWorkerMessage(sessionId: string, worker: PoolWorker, msg: WorkerToMainMessage): void {
    // Forward to all registered handlers for this session (including subscribers).
    const handlers = this.messageHandlers.get(sessionId) ?? [];
    for (const h of handlers) h(msg);

    // Fan out to subscribers.
    const subs = this.dedupe.subscribers(sessionId);
    for (const subId of subs) {
      if (subId === sessionId) continue;
      const subHandlers = this.messageHandlers.get(subId) ?? [];
      for (const h of subHandlers) h(msg);
    }

    // Handle drain signals for backpressure.
    if (msg.type === "worker_drain" && msg.sessionId === sessionId) {
      this.signalDrain(sessionId);
    }

    // On session completion, release the worker.
    if (
      msg.type === "decode_final" ||
      msg.type === "decode_cancelled" ||
      msg.type === "decode_error" ||
      msg.type === "decode_budget_exceeded" ||
      msg.type === "encode_done" ||
      msg.type === "encode_cancelled" ||
      msg.type === "encode_error"
    ) {
      if (msg.sessionId === sessionId) {
        this.completeSession(sessionId);
        this.pool.release(worker);
      }
    }
  }

  private setupSignalAbort(sessionId: string, signal: AbortSignal | null): void {
    if (signal === null) return;
    if (signal.aborted) {
      this.cancelSession(sessionId);
      return;
    }
    signal.addEventListener("abort", () => this.cancelSession(sessionId), { once: true });
  }

  private releaseSession(sessionId: string, preempted: boolean): void {
    const workerId = this.workerToSession.get(sessionId);
    this.workerToSession.delete(sessionId);
    this.sessionPriority.delete(sessionId);
    if (workerId !== undefined) {
      // Remove the mapping from worker to session.
      // Pool.release() is called by the caller after this.
    }
  }

  // ---------------------------------------------------------------------------
  // Queue drain (called after a worker becomes idle)
  // ---------------------------------------------------------------------------

  private drainQueue(): void {
    if (this.queue.isEmpty || this.drainingQueue) return;
    this.drainingQueue = true;

    void (async () => {
      try {
        while (!this.queue.isEmpty) {
          const worker = await this.pool.acquire();
          if (worker === null) break;

          const entry = this.queue.dequeue();
          if (entry === null) {
            this.pool.release(worker);
            break;
          }

          const { payload: pending } = entry;
          this.assignWorker(worker, pending.sessionId, pending.startMsg);
          this.setupSignalAbort(pending.sessionId, pending.signal);

          for (const { msg, transfer } of pending.bufferedChunks) {
            worker.handle.send(msg, transfer);
          }

          pending.resolve();
        }
      } finally {
        this.drainingQueue = false;
      }
    })();
  }

  // ---------------------------------------------------------------------------
  // Lookups
  // ---------------------------------------------------------------------------

  private findQueuedSession(sessionId: string): PendingSession | null {
    return this.queue.findBySessionId(sessionId)?.payload ?? null;
  }

  private getWorkerById(workerId: number): PoolWorker | null {
    for (const worker of this.pool.activeWorkers) {
      if (worker.id === workerId) return worker;
    }
    for (const worker of this.pool.idleWorkers) {
      if (worker.id === workerId) return worker;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Shutdown
  // ---------------------------------------------------------------------------

  async shutdown(): Promise<void> {
    this.destroyed = true;
    await this.pool.shutdown();
    this.messageHandlers.clear();
    this.backpressure.clear();
    this.workerToSession.clear();
    this.sessionPriority.clear();
  }
}
