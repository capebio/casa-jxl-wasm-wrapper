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
//
// Queue wait observability: when a session is forced to wait for a worker slot,
// we capture queuedAt and emit "scheduler_queue_wait_ms" (via the normal metric
// fan-out) on the queued→running transition. This enables parity measurements
// against the Tauri PrioritySem (ProcessResult.queue_wait_ms) and the synthetic
// lightbox_bench qwait column under concurrency + promotion (scenarios C/D).

import type {
  MainToWorkerMessage,
  WorkerToMainMessage,
  MsgDecodeStart,
  MsgEncodeStart,
} from "@casabio/jxl-core/protocol";

import type { AdmissionGate, Priority, PoolWorker, WorkerFactory, WorkerHandle } from "./types.js";
import { WorkerPool, RESERVED_SESSION_ID } from "./pool.js";
import { PriorityQueue } from "./queue.js";
import { DedupeRegistry } from "./dedupe.js";
import type { CoreBudget } from "./budget.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SchedulerOptions {
  factory: WorkerFactory;
  maxWorkers: number;
  idleTimeoutMs?: number;
  // Backpressure high-water mark: pushes after this depth block until worker drains. Default: 4.
  pushHwm?: number;
  // Number of workers to spawn eagerly at construction to eliminate first-image boot latency. Default: 0.
  prewarmSize?: number;
  // Optional shared CoreBudget for cross-scheduler bounding of live WASM thread pools (sched-1).
  coreBudget?: CoreBudget;
  // Optional pre-acquisition gate (sched-2). admit() awaited before any pool touches.
  admissionGate?: AdmissionGate;
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
  // Monotonic timestamp (performance.now()) captured at the moment we decided
  // to queue this session. Used to compute scheduler queue wait for benchmarks
  // and parity with the Tauri PrioritySem + lightbox_bench "qwait" metric.
  queuedAt: number;
}

interface BackpressureState {
  queueDepth: number;
  pendingPushes: Array<{ resolve: () => void; waitedAt: number }>;
  pendingHead: number;
}

// Single record per active session. Replaces six separate Maps that previously
// tracked worker, pending, handlers, backpressure, priority, and kind independently.
interface SessionRecord {
  sessionId: string;
  state: "queued" | "running" | "cancelling" | "paused";
  priority: Priority;
  kind: "decode" | "encode";
  handlers: Array<(msg: WorkerToMainMessage) => void>;
  // Set only while running; absent for queued sessions and dedupe subscribers.
  worker?: PoolWorker;
  // Set only while queued; cleared when a worker is assigned.
  pending?: PendingSession;
  backpressure?: BackpressureState;
  // Worker holding the paused WASM decoder state. Set only for "paused" sessions.
  pausedOnWorker?: PoolWorker;
  // Wall-clock time the session was created. Used for victim scoring.
  createdAt: number;
  // Monotonic time we entered the scheduler queue (only meaningful while state==="queued").
  // Populated for benchmark observability (parity with Tauri queue_wait_ms and lightbox_bench).
  queuedAt?: number;
  // Fractional decode progress [0, 1]. Updated from decode_progress stage messages.
  // Encode sessions stay at 0 (no protocol progress messages exist for encode).
  progress: number;
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
  private readonly admissionGate: AdmissionGate | undefined;
  private readonly gateReleases = new Map<string, () => void>();

  // All active sessions: primaries (running or queued) and dedupe subscribers.
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly pendingHandlers = new Map<string, Array<(msg: WorkerToMainMessage) => void>>();

  // Workers currently running background-priority sessions — enables O(n_background)
  // candidate scan for preemption without iterating the full session map.
  private readonly backgroundWorkers = new Set<PoolWorker>();

  // Maps worker id → paused session id. A worker holds at most one paused decode session
  // (the WASM decoder state is bound to that worker's heap and cannot migrate).
  private readonly workerPausedSession = new Map<number, string>();

  // Workers whose onMessage handler has already been wired — prevents stale-closure
  // accumulation when a worker handles multiple sessions across its lifetime.
  private readonly wiredWorkers = new WeakSet<PoolWorker>();

  private readonly pushHwm: number;

  private destroyed = false;
  private drainingQueue = false;
  private preemptionCount = 0;
  private totalSessionCount = 0;
  private _runningCount = 0;
  private _queuedCount = 0;
  private _pausedCount = 0;

  // Preemption victim scoring weights.
  private readonly PREEMPT_PROGRESS_W = 3.0;
  private readonly PREEMPT_AGE_W = 1.0;
  // Age is normalised over this window before scoring (sessions older than this score identically on age).
  private readonly PREEMPT_AGE_NORM_MS = 60_000;

  // Adaptive backpressure: EMA of how long a push actually blocked (ms).
  // Initialised to 50ms so the HWM starts neutral (no change from the configured base).
  private drainLatencyEma = 50;
  private readonly DRAIN_EMA_ALPHA = 0.2;

  constructor(opts: SchedulerOptions) {
    // Build pool options without relying on spread under exactOptionalPropertyTypes.
    // Always supply the required fields; conditionally attach coreBudget only when
    // provided (the value itself, never the |undefined form in the object shape).
    const poolCtorOpts: {
      factory: WorkerFactory;
      maxSize: number;
      idleTimeoutMs: number;
      coreBudget?: CoreBudget;
    } = {
      factory: opts.factory,
      maxSize: opts.maxWorkers,
      idleTimeoutMs: opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    };
    if (opts.coreBudget !== undefined) {
      poolCtorOpts.coreBudget = opts.coreBudget;
    }
    this.pool = new WorkerPool(poolCtorOpts);

    this.queue = new PriorityQueue<PendingSession>();
    this.dedupe = new DedupeRegistry();
    this.admissionGate = opts.admissionGate;
    this.pushHwm = opts.pushHwm ?? DEFAULT_PUSH_HWM;
    if (opts.prewarmSize && opts.prewarmSize > 0) {
      this.pool.prewarm(opts.prewarmSize);
    }
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
          handlers: this.takePendingHandlers(params.sessionId),
          createdAt: performance.now(),
          progress: 0,
        });
        this._runningCount++;
        this.totalSessionCount++;
        const primaryRecord = this.sessions.get(primaryId);
        return { workerId: primaryRecord?.worker?.id ?? -1 };
      }
      this.dedupe.register(params.sessionId, params.sourceKey);
    }

    // Pre-acquisition admission gate (sched-2): await BEFORE any pool.acquire,
    // tryAcquireIdle, or preemption. Controls concurrent active sessions
    // before workers are touched. Only primaries (non-deduped) reach here.
    if (this.admissionGate !== undefined) {
      const release = await this.admissionGate.admit(params.sessionId, params.priority);
      this.gateReleases.set(params.sessionId, release);
    }

    // Sync fast path: if an idle worker is available immediately, skip the
    // async hop (Promise + microtask) that pool.acquire() always incurs.
    const idleWorker = this.pool.tryAcquireIdle();
    if (idleWorker !== null) {
      this.assignWorker(idleWorker, params.sessionId, params.startMsg);
      this.setupSignalAbort(params.sessionId, params.signal);
      return { workerId: idleWorker.id };
    }

    // No idle worker — try spawn (async path).
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
        queuedAt: performance.now(),
      };
      this.sessions.set(params.sessionId, {
        sessionId: params.sessionId,
        state: "queued",
        priority: params.priority,
        kind: params.startMsg.type === "encode_start" ? "encode" : "decode",
        handlers: this.takePendingHandlers(params.sessionId),
        pending,
        createdAt: performance.now(),
        queuedAt: pending.queuedAt,
        progress: 0,
      });
      this._queuedCount++;
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

    // Paused: decoder lives in pausedOnWorker's WASM heap; forward directly so
    // chunks queue up inside the handler and are ready when the session resumes.
    if (record.state === "paused" && record.pausedOnWorker !== undefined) {
      record.pausedOnWorker.handle.send(msg, transfer);
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
    if (record === undefined) {
      let handlers = this.pendingHandlers.get(sessionId);
      if (handlers === undefined) {
        handlers = [];
        this.pendingHandlers.set(sessionId, handlers);
      }
      handlers.push(handler);
      return;
    }
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

    // Paused: send cancel to the worker hosting the dormant decoder, notify caller,
    // clean up immediately. The decode_cancelled ack arrives later but is silently
    // dropped since the session record is already gone.
    if (record?.state === "paused" && record.pausedOnWorker !== undefined) {
      this.workerPausedSession.delete(record.pausedOnWorker.id);
      record.pausedOnWorker.handle.send({ type: "decode_cancel", sessionId });
      delete record.pausedOnWorker;
      for (const h of record.handlers) h({ type: "decode_cancelled", sessionId });
      this.releaseAdmission(sessionId);
      this.dedupe.cancelSubscriber(sessionId);
      this._pausedCount--;
      this.sessions.delete(sessionId);
      return true;
    }

    // Queued: remove from queue and reject the pending promise.
    if (record?.state === "queued" && record.pending !== undefined) {
      const removed = this.queue.remove(sessionId);
      if (removed) {
        this.unblockBackpressure(record);
        record.pending.reject(new Error("[jxl-scheduler] Session cancelled."));
        this.releaseAdmission(sessionId);
        this.dedupe.cancelSubscriber(sessionId);
        this._queuedCount--;
        this.sessions.delete(sessionId);
        return true;
      }
    }

    // Subscriber (not primary): remove its record; other subscribers continue.
    const { cancelWorker, promotedTo } = this.dedupe.cancelSubscriber(sessionId);
    
    if (promotedTo !== undefined) {
      // Primary was cancelled, but a subscriber was promoted.
      // We must clean up the primary's record and rebind the worker to the new primary.
      const promotedRecord = this.sessions.get(promotedTo);
      if (record?.worker !== undefined && promotedRecord !== undefined) {
        // Transfer the worker to the promoted subscriber.
        promotedRecord.worker = record.worker;
        record.worker.activeSessionId = promotedTo;
      } else if (record?.pausedOnWorker !== undefined && promotedRecord !== undefined) {
        // Transfer paused state.
        promotedRecord.state = "paused";
        promotedRecord.pausedOnWorker = record.pausedOnWorker;
        this.workerPausedSession.set(record.pausedOnWorker.id, promotedTo);
      } else if (record?.pending !== undefined && promotedRecord !== undefined) {
        // Transfer queue position if still pending.
        promotedRecord.state = "queued";
        promotedRecord.pending = record.pending;
        promotedRecord.pending.sessionId = promotedTo;
        // Update the queue entry
        this.queue.remove(sessionId);
        this.queue.enqueue({ priority: promotedRecord.priority, sessionId: promotedTo, payload: promotedRecord.pending });
      }

      // Transfer gate admission (if held) to promoted so it is released when promoted work ends.
      const grel = this.gateReleases.get(sessionId);
      if (grel !== undefined && promotedRecord !== undefined) {
        this.gateReleases.delete(sessionId);
        this.gateReleases.set(promotedTo, grel);
      }

      if (record?.state === "running" || record?.state === "cancelling") this._runningCount--;
      else if (record?.state === "queued") this._queuedCount--;
      else if (record?.state === "paused") this._pausedCount--;
      this.sessions.delete(sessionId);
      return true;
    }

    if (!cancelWorker) {
      this.releaseAdmission(sessionId);
      if (record?.state === "running" || record?.state === "cancelling") this._runningCount--;
      else if (record?.state === "queued") this._queuedCount--;
      else if (record?.state === "paused") this._pausedCount--;
      this.sessions.delete(sessionId);
      return true;
    }

    // Running primary: send cancel to worker. Keep record until worker acks
    // (terminal message arrives in handleWorkerMessage → cleanupSession).
    if (record?.worker !== undefined) {
      this.releaseAdmission(sessionId);
      this.unblockBackpressure(record);
      // running → cancelling: no counter change (cancelling counts as running).
      record.state = "cancelling";
      record.handlers = []; // No more fan-out to this session's caller.
      record.worker.cancelling = true;
      record.worker.handle.send({
        type: record.kind === "encode" ? "encode_cancel" : "decode_cancel",
        sessionId,
      });
    } else if (record !== undefined) {
      // No worker, no pending — orphaned. Clean up.
      this.releaseAdmission(sessionId);
      if (record.state === "running" || record.state === "cancelling") this._runningCount--;
      else if (record.state === "queued") this._queuedCount--;
      else if (record.state === "paused") this._pausedCount--;
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
      record.backpressure = { queueDepth: 0, pendingPushes: [], pendingHead: 0 };
    }

    const bp = record.backpressure;
    bp.queueDepth++;
    if (bp.queueDepth < this.adaptiveHwm()) return;

    return new Promise<void>((resolve) => {
      bp.pendingPushes.push({ resolve, waitedAt: performance.now() });
    });
  }

  private signalDrain(sessionId: string): void {
    const bp = this.sessions.get(sessionId)?.backpressure;
    if (bp === undefined) return;
    bp.queueDepth = Math.max(0, bp.queueDepth - 1);
    if (bp.pendingHead < bp.pendingPushes.length) {
      const waiter = bp.pendingPushes[bp.pendingHead++];
      // Compact when head has consumed the whole array.
      if (bp.pendingHead >= bp.pendingPushes.length) {
        bp.pendingPushes.length = 0;
        bp.pendingHead = 0;
      }
      this.updateDrainEma(performance.now() - waiter!.waitedAt);
      waiter!.resolve();
    }
  }

  // Scale HWM up when draining fast, down when slow.
  // At 50ms EMA (init): factor ≈ 1 → HWM = pushHwm (neutral).
  // At 10ms: factor = 2 (capped) → HWM = pushHwm * 2, up to 16.
  // At 200ms: factor = 0.25 (floor) → HWM = max(2, pushHwm * 0.25).
  private adaptiveHwm(): number {
    const factor = Math.max(0.25, Math.min(2, 50 / (this.drainLatencyEma + 1)));
    return Math.max(2, Math.round(this.pushHwm * factor));
  }

  private updateDrainEma(latencyMs: number): void {
    this.drainLatencyEma = this.DRAIN_EMA_ALPHA * latencyMs + (1 - this.DRAIN_EMA_ALPHA) * this.drainLatencyEma;
  }

  // Unblock all pending waitForDrain calls — used on cancel/shutdown so callers don't hang.
  private unblockBackpressure(record: SessionRecord): void {
    if (record.backpressure === undefined) return;
    const { pendingPushes, pendingHead } = record.backpressure;
    for (let i = pendingHead; i < pendingPushes.length; i++) {
      pendingPushes[i]!.resolve();
    }
    delete record.backpressure;
  }

  // ---------------------------------------------------------------------------
  // Metrics
  // ---------------------------------------------------------------------------

  /**
   * Returns a shallow-cloned, frozen snapshot of scheduler metrics counters.
   * Decouples callers from internal mutable state. The returned object may be
   * retained across async boundaries; later mutations to scheduler (counters,
   * queue transitions, preemption counts) will not be visible to holders.
   * Freezing prevents receivers from mutating the snapshot they received.
   * Architectural guard for sched-4 (Metric Object Copy Protection).
   */
  getMetrics(): SchedulerMetrics {
    const snapshot: SchedulerMetrics = {
      running: this._runningCount,
      queued: this._queuedCount,
      paused: this._pausedCount,
      background: this.backgroundWorkers.size,
      preemptions: this.preemptionCount,
      totalSessions: this.totalSessionCount,
    };
    return Object.freeze(snapshot);
  }

  /**
   * Ensures a metric message's payload is decoupled before dispatch to any
   * onMessage handler (which ultimately feeds onMetric in jxl-session).
   * - Always returns a fresh top-level object for the dispatch (existing spread
   *   already did this for primary and per-subscriber copies).
   * - For type:"metric", shallow-clones the CodecMetric sub-object and freezes
   *   both wrapper and metric so that in-place mutation of "active" metric
   *   objects by producers cannot produce torn views for async listeners.
   *   Listeners holding the metric across ticks see the value at dispatch time.
   * This is the central enforcement point for sched-4.
   */
  private protectMetricForDispatch(msg: WorkerToMainMessage): WorkerToMainMessage {
    if (msg.type !== "metric") {
      return msg;
    }
    const clonedMetric = Object.freeze({ ...(msg.metric as object) });
    const protectedMsg = Object.freeze({ ...msg, metric: clonedMetric }) as WorkerToMainMessage;
    return protectedMsg;
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

    // Decode victims are paused (WASM state preserved for resume).
    // Encode victims are cancelled (no in-progress state worth preserving).
    const usePause = victimKind === "decode";

    backgroundWorker.cancelling = true;
    const prevHandlers = victimRecord?.handlers ?? [];
    let ackResolved = false;

    const ack = new Promise<void>((resolve) => {
      const handler = (msg: WorkerToMainMessage) => {
        const matched = usePause
          ? (msg.type === "decode_paused" && msg.sessionId === victimSessionId)
          : ((msg.type === "decode_cancelled" || msg.type === "encode_cancelled") && msg.sessionId === victimSessionId);
        if (matched) {
          ackResolved = true;
          resolve();
          if (victimRecord) prevHandlers.shift();
        }
      };
      if (victimRecord) prevHandlers.unshift(handler);

      if (usePause) {
        backgroundWorker.handle.send({ type: "decode_pause", sessionId: victimSessionId });
      } else if (victimKind === "encode") {
        backgroundWorker.handle.send({ type: "encode_cancel", sessionId: victimSessionId, reason: "preempted" });
      } else {
        backgroundWorker.handle.send({ type: "decode_cancel", sessionId: victimSessionId, reason: "preempted" });
      }
    });

    // 2-second timeout prevents indefinite wait on an unresponsive worker.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        ack,
        new Promise<void>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("preempt-timeout")), 2000);
        }),
      ]);
    } catch {
      if (victimRecord) prevHandlers.shift();
      this.pool.recycle(backgroundWorker);
    } finally {
      clearTimeout(timeout);
    }
    backgroundWorker.cancelling = false;

    if (!ackResolved) {
      // Timed out: worker recycled (pool.recycle terminates it). The terminal
      // decode_cancelled from the worker may never arrive (activeSessionId is
      // cleared during teardown, so handleWorkerMessage silently drops it).
      // Use cleanupSession — not releaseSession — to ensure _runningCount is
      // decremented and the session record is removed from the map now.
      this.cleanupSession(victimSessionId);
      const newWorker = await this.pool.acquire();
      if (newWorker !== null) {
        this.assignWorker(newWorker, params.sessionId, params.startMsg);
        this.setupSignalAbort(params.sessionId, params.signal);
        this.preemptionCount++;
        return newWorker.id;
      }
      return null;
    }

    if (usePause) {
      // Park the victim: keep its session record alive but detach from the active worker.
      // The WASM decoder state remains in the worker's heap until the session resumes.
      if (victimRecord !== undefined) {
        // running → paused
        this._runningCount--;
        this._pausedCount++;
        victimRecord.state = "paused";
        delete victimRecord.worker;
        victimRecord.pausedOnWorker = backgroundWorker;
        this.backgroundWorkers.delete(backgroundWorker);
      }
      this.workerPausedSession.set(backgroundWorker.id, victimSessionId);
      this.pool.park(backgroundWorker);
      this.pool.unpark(backgroundWorker);
      backgroundWorker.activeSessionId = RESERVED_SESSION_ID;
      backgroundWorker.cancelling = false;
      this.assignWorker(backgroundWorker, params.sessionId, params.startMsg);
      this.setupSignalAbort(params.sessionId, params.signal);
      this.preemptionCount++;
      return backgroundWorker.id;
    } else {
      // Cancel: victim's caller receives the cancellation and handles resubmit.
      this.releaseSession(victimSessionId);
    }

    if (!backgroundWorker.handle.terminated) {
      this.assignWorker(backgroundWorker, params.sessionId, params.startMsg);
      this.setupSignalAbort(params.sessionId, params.signal);
      this.preemptionCount++;
      return backgroundWorker.id;
    }

    // Worker died between ack and reassign (rare). If paused, clean up the parked session.
    if (usePause) {
      this.workerPausedSession.delete(backgroundWorker.id);
      if (victimRecord !== undefined) {
        // paused → cancelling (counts as running for metrics)
        this._pausedCount--;
        this._runningCount++;
        victimRecord.state = "cancelling";
        delete victimRecord.pausedOnWorker;
      }
      this.releaseSession(victimSessionId);
    }
    const newWorker = await this.pool.acquire();
    if (newWorker !== null) {
      this.assignWorker(newWorker, params.sessionId, params.startMsg);
      this.setupSignalAbort(params.sessionId, params.signal);
      this.preemptionCount++;
      return newWorker.id;
    }
    return null;
  }

  // Score a candidate preemption victim. Lower score = better victim.
  // Prefer sessions with low progress (less re-work on resubmit) and low age
  // (less wall-clock time invested). Age is normalised to [0,1] to keep it
  // on the same scale as progress.
  private scoreVictim(record: SessionRecord): number {
    const ageNorm = Math.min(1, (performance.now() - record.createdAt) / this.PREEMPT_AGE_NORM_MS);
    return record.progress * this.PREEMPT_PROGRESS_W + ageNorm * this.PREEMPT_AGE_W;
  }

  private findBackgroundWorker(): PoolWorker | null {
    let bestWorker: PoolWorker | null = null;
    let bestScore = Infinity;

    for (const worker of this.backgroundWorkers) {
      if (worker.cancelling || worker.activeSessionId === null) continue;
      // Skip workers already holding a paused session — their decoder slot is occupied.
      if (this.workerPausedSession.has(worker.id)) continue;
      const record = this.sessions.get(worker.activeSessionId);
      if (record === undefined) continue;
      const score = this.scoreVictim(record);
      if (score < bestScore) {
        bestScore = score;
        bestWorker = worker;
      }
    }
    return bestWorker;
  }

  // Resume a paused session on the worker that holds its decoder state.
  private resumePausedSession(worker: PoolWorker, sessionId: string): void {
    const record = this.sessions.get(sessionId);
    if (record === undefined || record.state !== "paused") {
      // Session was cancelled while paused; release the worker normally.
      this.pool.release(worker);
      this.drainQueue();
      return;
    }
    this.pool.bind(worker, sessionId);
    // paused → running
    this._pausedCount--;
    this._runningCount++;
    record.state = "running";
    record.worker = worker;
    delete record.pausedOnWorker;
    if (record.priority === "background") this.backgroundWorkers.add(worker);
    else this.backgroundWorkers.delete(worker);
    this.ensureWorkerWired(worker);
    worker.handle.send({ type: "decode_resume", sessionId });
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
      // queued → running
      this._queuedCount--;
      this._runningCount++;
      existing.state = "running";
      existing.worker = worker;
      delete existing.pending;

      // Emit scheduler-level queue wait metric for benchmarks / parity with
      // Tauri process_file.queue_wait_ms and the synthetic lightbox_bench qwait.
      // Only queued sessions have a meaningful wait; immediate/preempt paths
      // never entered the PendingSession queue.
      if (existing.queuedAt != null) {
        const waitMs = performance.now() - existing.queuedAt;
        // Construct *fresh* metric payload every time (no pre-allocated mutable).
        // protectMetricForDispatch will shallow-clone the CodecMetric and freeze
        // before the handler call. This guarantees that any onMetric consumer
        // (or test that stashes the payload across a tick) sees a stable value
        // even if more queue-waits or counter mutations happen later in the
        // scheduler. Enforces sched-4: no torn async views of active metrics.
        const metricMsg = {
          type: "metric" as const,
          sessionId,
          metric: { name: "scheduler_queue_wait_ms" as const, value: waitMs },
        } as WorkerToMainMessage;
        for (const h of existing.handlers) {
          try { h(this.protectMetricForDispatch(metricMsg)); } catch { /* handler must not throw */ }
        }
      }
      delete existing.queuedAt;
    } else {
      // Fresh session (immediate acquire or post-preemption).
      this.sessions.set(sessionId, {
        sessionId,
        state: "running",
        priority,
        kind,
        handlers: this.takePendingHandlers(sessionId),
        worker,
        createdAt: performance.now(),
        progress: 0,
      });
      this._runningCount++;
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
      if (sessionId === null || sessionId === RESERVED_SESSION_ID) return;
      this.handleWorkerMessage(sessionId, worker, msg);
    });
  }

  private static readonly STAGE_PROGRESS: Readonly<Record<string, number>> = {
    header: 0.1,
    dc: 0.3,
    pass: 0.6,
    final: 0.95,
  };

  private handleWorkerMessage(sessionId: string, worker: PoolWorker, rawMsg: WorkerToMainMessage): void {
    // Re-stamp the message with the scheduler's current active session ID.
    // This is critical if the worker was promoted to a new primary, as the worker
    // itself is unaware of the JS-side session ID change.
    const msg = { ...rawMsg, sessionId } as WorkerToMainMessage & { sessionId: string };

    const record = this.sessions.get(sessionId);
    const handlers = record?.handlers ?? EMPTY_HANDLERS;
    for (const h of handlers) h(this.protectMetricForDispatch(msg));

    // Fan out to dedupe subscribers.
    this.dedupe.forEachSubscriber(sessionId, (subId) => {
      if (subId === sessionId) return;
      const subRecord = this.sessions.get(subId);
      const subHandlers = subRecord?.handlers ?? EMPTY_HANDLERS;
      const stampedMsg = { ...msg, sessionId: subId };
      for (const h of subHandlers) h(this.protectMetricForDispatch(stampedMsg));
    });

    // Track decode progress for victim scoring. The stage is used as a proxy for
    // fractional completion so that nearly-done sessions are spared from preemption.
    if (record !== undefined && msg.type === "decode_progress") {
      const p = Scheduler.STAGE_PROGRESS[msg.stage];
      if (p !== undefined) record.progress = Math.max(record.progress, p);
    }

    if (msg.type === "worker_drain" && msg.sessionId === sessionId) {
      this.signalDrain(sessionId);
    }

    // On completion: clean up, then either resume a parked session on this worker
    // or release it to the pool for the queue drain.
    if (this.isTerminalMessage(msg) && msg.sessionId === sessionId) {
      this.cleanupSession(sessionId);
      const pausedId = this.workerPausedSession.get(worker.id);
      if (pausedId !== undefined) {
        this.workerPausedSession.delete(worker.id);
        this.resumePausedSession(worker, pausedId);
      } else {
        this.pool.release(worker);
        this.drainQueue();
      }
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

  private takePendingHandlers(sessionId: string): Array<(msg: WorkerToMainMessage) => void> {
    const handlers = this.pendingHandlers.get(sessionId);
    if (handlers === undefined) return [];
    this.pendingHandlers.delete(sessionId);
    return handlers;
  }

  // Release the AdmissionGate slot (if any) for this sessionId (sched-2).
  private releaseAdmission(sessionId: string): void {
    const rel = this.gateReleases.get(sessionId);
    if (rel !== undefined) {
      this.gateReleases.delete(sessionId);
      try { rel(); } catch { /* releases must not propagate */ }
    }
  }

  private releaseAllAdmissions(): void {
    for (const [, rel] of this.gateReleases) {
      try { rel(); } catch { /* releases must not propagate */ }
    }
    this.gateReleases.clear();
  }

  // Tears down session state without triggering a queue drain.
  private cleanupSession(sessionId: string): void {
    this.releaseAdmission(sessionId);
    const record = this.sessions.get(sessionId);
    if (record !== undefined) {
      if (record.state === "running" || record.state === "cancelling") this._runningCount--;
      else if (record.state === "queued") this._queuedCount--;
      else if (record.state === "paused") this._pausedCount--;
    }
    this.releaseSession(sessionId);
    this.dedupe.complete(sessionId);
    this.sessions.delete(sessionId);
    this.pendingHandlers.delete(sessionId);
  }

  private releaseSession(sessionId: string): void {
    const record = this.sessions.get(sessionId);
    if (record?.worker !== undefined) {
      this.backgroundWorkers.delete(record.worker);
    }
    if (record?.pausedOnWorker !== undefined) {
      this.backgroundWorkers.delete(record.pausedOnWorker);
      this.workerPausedSession.delete(record.pausedOnWorker.id);
    }
  }

  // ---------------------------------------------------------------------------
  // Queue drain (called after a worker becomes idle)
  // ---------------------------------------------------------------------------

  private drainQueue(): void {
    if (this.queue.isEmpty || this.drainingQueue) return;
    this.drainingQueue = true;

    // Sync fast path: drain all entries that have an immediately available idle
    // worker, skipping the async hop (Promise allocation + microtask scheduling).
    // Common steady-state case: a worker just finished, queue has work, pool has
    // an idle slot — no need for an async round-trip.
    while (!this.queue.isEmpty) {
      const worker = this.pool.tryAcquireIdle();
      if (worker === null) break;
      const entry = this.queue.dequeue();
      if (entry === null) { this.pool.release(worker); break; }
      const { payload: pending } = entry;
      this.assignWorker(worker, pending.sessionId, pending.startMsg);
      this.setupSignalAbort(pending.sessionId, pending.signal);
      for (const { msg, transfer } of pending.bufferedChunks) {
        worker.handle.send(msg, transfer);
      }
      pending.resolve();
    }

    if (this.queue.isEmpty) {
      this.drainingQueue = false;
      return;
    }

    // Async path: no idle workers available; wait for spawn or worker release.
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
      } catch (err: unknown) {
        console.error("[jxl-scheduler] drainQueue error:", err);
        setTimeout(() => this.drainQueue(), 50);
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

    // Reject/notify all non-running sessions so their callers don't hang.
    const shutdownErr = new Error("[jxl-scheduler] Scheduler shut down.");
    for (const record of this.sessions.values()) {
      if (record.state === "queued" && record.pending !== undefined) {
        this.unblockBackpressure(record);
        record.pending.reject(shutdownErr);
      } else if (record.state === "paused") {
        // Notify paused-session callers with a synthetic cancelled message.
        for (const h of record.handlers) h({ type: "decode_cancelled", sessionId: record.sessionId });
      }
    }

    this.releaseAllAdmissions();

    await this.pool.shutdown();
    this._runningCount = 0;
    this._queuedCount = 0;
    this._pausedCount = 0;
    this.sessions.clear();
    this.backgroundWorkers.clear();
    this.workerPausedSession.clear();
    this.gateReleases.clear();
  }
}

