// jxl-scheduler/src/scheduler.ts
// Core scheduler: pool, three priority lanes, preemption, dedupe, budget.
// Spec: Section 12, T-SCHEDULER brief.
//
// Preemption invariant (Section 12.2):
//   A visible job entering a full pool preempts one background job.
//   Steps: send decode_cancel/encode_cancel, await cancelled ack, reassign worker.
//   Preempted job caller receives cancelled message and is responsible for resubmit.
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
  // Backpressure high-water mark: pushes after this depth block until worker drains. Default: 4.
  pushHwm?: number;
}

export interface SchedulerMetrics {
  /** Sessions currently assigned to a worker (includes cancelling). */
  running: number;
  /** Sessions waiting in the priority queue for a worker slot. */
  queued: number;
  /** Running sessions with background priority. */
  background: number;
  /** Total preemptions performed since construction. */
  preemptions: number;
  /** Total sessions created since construction. */
  totalSessions: number;
}

// ---------------------------------------------------------------------------
// Private types
// ---------------------------------------------------------------------------

// A session waiting in the queue for a worker slot.
interface PendingSession {
  sessionId: string;
  priority: Priority;
  startMsg: MsgDecodeStart | MsgEncodeStart;
  // Chunks accumulated before the worker was assigned.
  bufferedChunks: Array<{ msg: MainToWorkerMessage; transfer: ArrayBuffer[] }>;
  resolve: () => void;
  reject: (err: unknown) => void;
  signal: AbortSignal | null;
  isRequeue: boolean;
}

interface BackpressureState {
  queueDepth: number;
  pendingPushes: Array<{ resolve: () => void }>;
}

// Single record per active session. Replaces six separate Maps that previously
// tracked worker, pending, handlers, backpressure, priority, and kind independently.
interface SessionRecord {
  sessionId: string;
  state: "queued" | "running" | "cancelling";
  priority: Priority;
  kind: "decode" | "encode";
  handlers: Array<(msg: WorkerToMainMessage) => void>;
  // Set only while running; absent for queued sessions and dedupe subscribers.
  worker?: PoolWorker;
  // Set only while queued; cleared when a worker is assigned.
  pending?: PendingSession;
  backpressure?: BackpressureState;
  // Wall-clock time the session was created. Used for victim selection: we
  // prefer to preempt the oldest background session (least expected re-work).
  createdAt: number;
}

const DEFAULT_PUSH_HWM = 4;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

// Shared empty array — avoids per-message allocation when no handlers registered.
const EMPTY_HANDLERS: ReadonlyArray<(msg: WorkerToMainMessage) => void> = [];

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export class Scheduler {
  private readonly pool: WorkerPool;
  private readonly queue: PriorityQueue<PendingSession>;
  private readonly dedupe: DedupeRegistry;

  // All active sessions: primaries (running or queued) and dedupe subscribers.
  private readonly sessions = new Map<string, SessionRecord>();

  // Workers currently running background-priority sessions — enables O(n_background)
  // candidate scan for preemption without iterating the full session map.
  private readonly backgroundWorkers = new Set<PoolWorker>();

  // Workers whose onMessage handler has already been wired — prevents stale-closure
  // accumulation when a worker handles multiple sessions across its lifetime.
  private readonly wiredWorkers = new WeakSet<PoolWorker>();

  private readonly pushHwm: number;

  private destroyed = false;
  private drainingQueue = false;
  private preemptionCount = 0;
  private totalSessionCount = 0;

  constructor(opts: SchedulerOptions) {
    this.pool = new WorkerPool({
      factory: opts.factory,
      maxSize: opts.maxWorkers,
      idleTimeoutMs: opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    });
    this.queue = new PriorityQueue<PendingSession>();
    this.dedupe = new DedupeRegistry();
    this.pushHwm = opts.pushHwm ?? DEFAULT_PUSH_HWM;
  }

  // ---------------------------------------------------------------------------
  // Session acquisition — called by jxl-session to reserve a worker slot
  // ---------------------------------------------------------------------------

  async acquireSlot(params: {
    sessionId: string;
    priority: Priority;
    startMsg: MsgDecodeStart | MsgEncodeStart;
    sourceKey: string | null;
    signal: AbortSignal | null;
  }): Promise<{ workerId: number }> {
    if (this.destroyed) throw new Error("[jxl-scheduler] Scheduler is shut down.");

    // Dedupe check: if a session for this sourceKey already exists, fan out.
    if (params.sourceKey !== null) {
      const primaryId = this.dedupe.findPrimary(params.sourceKey);
      if (primaryId !== null) {
        this.dedupe.subscribe(params.sessionId, primaryId);
        // Subscriber gets a lightweight record — handlers only, no worker/pending.
        this.sessions.set(params.sessionId, {
          sessionId: params.sessionId,
          state: "running",
          priority: params.priority,
          kind: params.startMsg.type === "encode_start" ? "encode" : "decode",
          handlers: [],
          createdAt: Date.now(),
        });
        this.totalSessionCount++;
        const primaryRecord = this.sessions.get(primaryId);
        return { workerId: primaryRecord?.worker?.id ?? -1 };
      }
      this.dedupe.register(params.sessionId, params.sourceKey);
    }

    // Try to immediately acquire a worker.
    const worker = await this.pool.acquire();
    if (worker !== null) {
      this.assignWorker(worker, params.sessionId, params.startMsg);
      this.setupSignalAbort(params.sessionId, params.signal);
      return { workerId: worker.id };
    }

    // No worker available — check for preemption opportunity.
    if (params.priority === "visible") {
      const preempted = await this.tryPreempt(params);
      if (preempted !== null) return { workerId: preempted };
    }

    // Queue the session and wait for a slot.
    return new Promise<{ workerId: number }>((resolve, reject) => {
      const pending: PendingSession = {
        sessionId: params.sessionId,
        priority: params.priority,
        startMsg: params.startMsg,
        bufferedChunks: [],
        resolve: () => resolve({ workerId: this.sessions.get(params.sessionId)?.worker?.id ?? -1 }),
        reject,
        signal: params.signal,
        isRequeue: false,
      };
      this.sessions.set(params.sessionId, {
        sessionId: params.sessionId,
        state: "queued",
        priority: params.priority,
        kind: params.startMsg.type === "encode_start" ? "encode" : "decode",
        handlers: [],
        pending,
        createdAt: Date.now(),
      });
      this.totalSessionCount++;
      this.queue.enqueue({ priority: params.priority, sessionId: params.sessionId, payload: pending });
      this.setupSignalAbort(params.sessionId, params.signal);
    });
  }

  // ---------------------------------------------------------------------------
  // Message forwarding — called by jxl-session to send messages to a worker
  // ---------------------------------------------------------------------------

  send(sessionId: string, msg: MainToWorkerMessage, transfer: ArrayBuffer[] = []): void {
    const record = this.sessions.get(sessionId);
    if (record === undefined) return;

    if (record.worker !== undefined) {
      record.worker.handle.send(msg, transfer);
      return;
    }

    // Queued: buffer the chunk for delivery once a worker is assigned.
    if (record.pending !== undefined) {
      record.pending.bufferedChunks.push({ msg, transfer });
    }
  }

  // Register a handler to receive messages from the worker for this session.
  onMessage(sessionId: string, handler: (msg: WorkerToMainMessage) => void): void {
    const record = this.sessions.get(sessionId);
    if (record === undefined) return;
    record.handlers.push(handler);
  }

  // ---------------------------------------------------------------------------
  // Session completion / cancellation
  // ---------------------------------------------------------------------------

  completeSession(sessionId: string): void {
    this.cleanupSession(sessionId);
    this.drainQueue();
  }

  cancelSession(sessionId: string): boolean {
    const record = this.sessions.get(sessionId);

    // Queued: remove from queue and reject the pending promise.
    if (record?.state === "queued" && record.pending !== undefined) {
      const removed = this.queue.remove(sessionId);
      if (removed) {
        this.unblockBackpressure(record);
        record.pending.reject(new Error("[jxl-scheduler] Session cancelled."));
        this.dedupe.cancelSubscriber(sessionId);
        this.sessions.delete(sessionId);
        return true;
      }
    }

    // Subscriber (not primary): remove its record; other subscribers continue.
    const shouldCancelPrimary = this.dedupe.cancelSubscriber(sessionId);
    if (!shouldCancelPrimary) {
      this.sessions.delete(sessionId);
      return true;
    }

    // Running primary: send cancel to worker. Keep record until worker acks
    // (terminal message arrives in handleWorkerMessage → cleanupSession).
    if (record?.worker !== undefined) {
      this.unblockBackpressure(record);
      record.state = "cancelling";
      record.handlers = []; // No more fan-out to this session's caller.
      record.worker.cancelling = true;
      record.worker.handle.send({
        type: record.kind === "encode" ? "encode_cancel" : "decode_cancel",
        sessionId,
      });
    } else if (record !== undefined) {
      // No worker, no pending — orphaned. Clean up.
      this.sessions.delete(sessionId);
    }

    return true;
  }

  // ---------------------------------------------------------------------------
  // Backpressure
  // ---------------------------------------------------------------------------

  async waitForDrain(sessionId: string): Promise<void> {
    const record = this.sessions.get(sessionId);
    if (record === undefined) return;

    if (record.backpressure === undefined) {
      record.backpressure = { queueDepth: 0, pendingPushes: [] };
    }

    const bp = record.backpressure;
    bp.queueDepth++;
    if (bp.queueDepth < this.pushHwm) return;

    return new Promise<void>((resolve) => {
      bp.pendingPushes.push({ resolve });
    });
  }

  private signalDrain(sessionId: string): void {
    const bp = this.sessions.get(sessionId)?.backpressure;
    if (bp === undefined) return;
    bp.queueDepth = Math.max(0, bp.queueDepth - 1);
    const waiter = bp.pendingPushes.shift();
    if (waiter !== undefined) waiter.resolve();
  }

  // Unblock all pending waitForDrain calls — used on cancel/shutdown so callers don't hang.
  private unblockBackpressure(record: SessionRecord): void {
    if (record.backpressure === undefined) return;
    for (const waiter of record.backpressure.pendingPushes) waiter.resolve();
    delete record.backpressure;
  }

  // ---------------------------------------------------------------------------
  // Metrics
  // ---------------------------------------------------------------------------

  getMetrics(): SchedulerMetrics {
    let running = 0;
    let queued = 0;
    for (const record of this.sessions.values()) {
      if (record.state === "running" || record.state === "cancelling") running++;
      else if (record.state === "queued") queued++;
    }
    return {
      running,
      queued,
      background: this.backgroundWorkers.size,
      preemptions: this.preemptionCount,
      totalSessions: this.totalSessionCount,
    };
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
    const backgroundWorker = this.findBackgroundWorker();
    if (backgroundWorker === null) return null;

    const victimSessionId = backgroundWorker.activeSessionId!;
    const victimRecord = this.sessions.get(victimSessionId);
    const victimKind = victimRecord?.kind ?? "decode";

    // Send cancel and await ack.
    backgroundWorker.cancelling = true;
    const cancelAck = new Promise<void>((resolve) => {
      const prevHandlers = victimRecord?.handlers ?? [];
      const cancelHandler = (msg: WorkerToMainMessage) => {
        if (
          (msg.type === "decode_cancelled" || msg.type === "encode_cancelled") &&
          msg.sessionId === victimSessionId
        ) {
          resolve();
          // Restore so the victim's caller receives the cancellation notification.
          if (victimRecord) victimRecord.handlers = prevHandlers;
        }
      };
      if (victimRecord) victimRecord.handlers = [cancelHandler, ...prevHandlers];
      backgroundWorker.handle.send({
        type: victimKind === "encode" ? "encode_cancel" : "decode_cancel",
        sessionId: victimSessionId,
        reason: "preempted",
      });
    });

    // 2-second timeout prevents indefinite wait on an unresponsive worker.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        cancelAck,
        new Promise<void>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("preempt-timeout")), 2000);
        }),
      ]);
    } catch {
      this.pool.recycle(backgroundWorker);
    } finally {
      clearTimeout(timeout);
    }

    // The victim's caller receives the cancelled message and handles resubmit.
    this.releaseSession(victimSessionId);

    if (!backgroundWorker.handle.terminated) {
      this.assignWorker(backgroundWorker, params.sessionId, params.startMsg);
      this.setupSignalAbort(params.sessionId, params.signal);
      this.preemptionCount++;
      return backgroundWorker.id;
    }

    // Worker was recycled during cancel; try acquiring a fresh one.
    const newWorker = await this.pool.acquire();
    if (newWorker !== null) {
      this.assignWorker(newWorker, params.sessionId, params.startMsg);
      this.setupSignalAbort(params.sessionId, params.signal);
      this.preemptionCount++;
      return newWorker.id;
    }

    return null;
  }

  // Return the oldest running background worker as the preemption victim.
  // Oldest = smallest createdAt. Preempting the oldest minimises the expected
  // re-work cost for the background caller on resubmit, since newer sessions
  // are more likely to still be near the start of their decode.
  private findBackgroundWorker(): PoolWorker | null {
    let bestWorker: PoolWorker | null = null;
    let oldestCreatedAt = Infinity;

    for (const worker of this.backgroundWorkers) {
      if (worker.cancelling || worker.activeSessionId === null) continue;
      const record = this.sessions.get(worker.activeSessionId);
      const createdAt = record?.createdAt ?? Date.now();
      if (createdAt < oldestCreatedAt) {
        oldestCreatedAt = createdAt;
        bestWorker = worker;
      }
    }
    return bestWorker;
  }

  // ---------------------------------------------------------------------------
  // Assignment helpers
  // ---------------------------------------------------------------------------

  private assignWorker(worker: PoolWorker, sessionId: string, startMsg: MsgDecodeStart | MsgEncodeStart): void {
    this.pool.bind(worker, sessionId);

    const priority = startMsg.priority;
    const kind = startMsg.type === "encode_start" ? "encode" : "decode";

    // Queued → running transition: update existing record in-place.
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) {
      existing.state = "running";
      existing.worker = worker;
      delete existing.pending;
    } else {
      // Fresh session (immediate acquire or post-preemption).
      this.sessions.set(sessionId, {
        sessionId,
        state: "running",
        priority,
        kind,
        handlers: [],
        worker,
        createdAt: Date.now(),
      });
      this.totalSessionCount++;
    }

    if (priority === "background") this.backgroundWorkers.add(worker);
    else this.backgroundWorkers.delete(worker);

    // Wire the worker's message callback exactly once per worker lifetime —
    // prevents stale closures accumulating across session reuse.
    this.ensureWorkerWired(worker);

    worker.handle.send(startMsg);
  }

  private ensureWorkerWired(worker: PoolWorker): void {
    if (this.wiredWorkers.has(worker)) return;
    this.wiredWorkers.add(worker);
    worker.handle.onMessage((msg) => {
      const sessionId = worker.activeSessionId;
      if (sessionId === null || sessionId === "__reserved__") return;
      this.handleWorkerMessage(sessionId, worker, msg);
    });
  }

  private handleWorkerMessage(sessionId: string, worker: PoolWorker, msg: WorkerToMainMessage): void {
    const record = this.sessions.get(sessionId);
    const handlers = record?.handlers ?? EMPTY_HANDLERS;
    for (const h of handlers) h(msg);

    // Fan out to dedupe subscribers.
    this.dedupe.forEachSubscriber(sessionId, (subId) => {
      if (subId === sessionId) return;
      const subRecord = this.sessions.get(subId);
      const subHandlers = subRecord?.handlers ?? EMPTY_HANDLERS;
      for (const h of subHandlers) h(msg);
    });

    if (msg.type === "worker_drain" && msg.sessionId === sessionId) {
      this.signalDrain(sessionId);
    }

    // On completion: clean up, release the worker, then drain so the pool slot
    // is available before drainQueue calls pool.acquire().
    if (this.isTerminalMessage(msg) && msg.sessionId === sessionId) {
      this.cleanupSession(sessionId);
      this.pool.release(worker);
      this.drainQueue();
    }
  }

  private isTerminalMessage(msg: WorkerToMainMessage): msg is WorkerToMainMessage & { sessionId: string } {
    switch (msg.type) {
      case "decode_final":
      case "decode_cancelled":
      case "decode_error":
      case "decode_budget_exceeded":
      case "encode_done":
      case "encode_cancelled":
      case "encode_error":
        return true;
      default:
        return false;
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

  // Tears down session state without triggering a queue drain.
  private cleanupSession(sessionId: string): void {
    this.releaseSession(sessionId);
    this.dedupe.complete(sessionId);
    this.sessions.delete(sessionId);
  }

  private releaseSession(sessionId: string): void {
    const record = this.sessions.get(sessionId);
    if (record?.worker !== undefined) {
      this.backgroundWorkers.delete(record.worker);
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
  // Shutdown
  // ---------------------------------------------------------------------------

  async shutdown(): Promise<void> {
    this.destroyed = true;

    // Reject all queued sessions so their callers don't hang.
    const shutdownErr = new Error("[jxl-scheduler] Scheduler shut down.");
    for (const record of this.sessions.values()) {
      if (record.state === "queued" && record.pending !== undefined) {
        this.unblockBackpressure(record);
        record.pending.reject(shutdownErr);
      }
    }

    await this.pool.shutdown();
    this.sessions.clear();
    this.backgroundWorkers.clear();
  }
}
