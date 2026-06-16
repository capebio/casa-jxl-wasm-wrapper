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
//   budgetMs is session-level elapsed time from session construction; never per-stage.
//   On breach: session emits decode_budget_exceeded with best frame so far.
//
// Queue wait observability: when a session is forced to wait for a worker slot,
// we capture queuedAt and emit "scheduler_queue_wait_ms" (via the normal metric
// fan-out) on the queued→running transition. This enables parity measurements
// against the Tauri PrioritySem (ProcessResult.queue_wait_ms) and the synthetic
// lightbox_bench qwait column under concurrency + promotion (scenarios C/D).
import { WorkerPool, RESERVED_SESSION_ID } from "./pool.js";
import { PriorityQueue } from "./queue.js";
import { DedupeRegistry } from "./dedupe.js";
const DEFAULT_PUSH_HWM = 4;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
// Shared empty array — avoids per-message allocation when no handlers registered.
const EMPTY_HANDLERS = [];
// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------
export class Scheduler {
    pool;
    queue;
    dedupe;
    admissionGate;
    gateReleases = new Map();
    // All active sessions: primaries (running or queued) and dedupe subscribers.
    sessions = new Map();
    pendingHandlers = new Map();
    // Workers currently running background-priority sessions — enables O(n_background)
    // candidate scan for preemption without iterating the full session map.
    backgroundWorkers = new Set();
    // Maps worker id → paused session id. A worker holds at most one paused decode session
    // (the WASM decoder state is bound to that worker's heap and cannot migrate).
    //
    // Memory: each parked session pins a full WASM decoder (including its output pixel
    // buffers) in the worker. Parked workers are removed from the active/idle sets.
    // No cap exists; concurrent visible preemptions can pin multiple decoder heaps.
    // Candidate future feature (not implemented): evict/cancel oldest parked when
    // parked count exceeds a threshold to bound memory under pathological preemption.
    workerPausedSession = new Map();
    // Track stale session ids per worker and drop their traffic at the wire (S1)
    discardSessions = new Map();
    // Tracking sessions cancelled during admission or spawn waits to prevent ghost decode (S5)
    cancelledDuringAcquisition = new Set();
    // Workers whose onMessage handler has already been wired — prevents stale-closure
    // accumulation when a worker handles multiple sessions across its lifetime.
    wiredWorkers = new WeakSet();
    pushHwm;
    maxParkedSessions;
    destroyed = false;
    drainingQueue = false;
    preemptionCount = 0;
    totalSessionCount = 0;
    _runningCount = 0;
    _queuedCount = 0;
    _pausedCount = 0;
    _subscriberCount = 0;
    // Preemption victim scoring weights.
    PREEMPT_PROGRESS_W = 3.0;
    PREEMPT_AGE_W = 1.0;
    // Cancelled encodes lose all work; paused decodes lose none (S10)
    PREEMPT_ENCODE_W = 1.5;
    // Age is normalised over this window before scoring (sessions older than this score identically on age).
    PREEMPT_AGE_NORM_MS = 60_000;
    // Adaptive backpressure: EMA of how long a push actually blocked (ms).
    // Initialised to 50ms so the HWM starts neutral (no change from the configured base).
    drainLatencyEma = 50;
    DRAIN_EMA_ALPHA = 0.2;
    constructor(opts) {
        // Build pool options without relying on spread under exactOptionalPropertyTypes.
        // Always supply the required fields; conditionally attach coreBudget only when
        // provided (the value itself, never the |undefined form in the object shape).
        const poolCtorOpts = {
            factory: opts.factory,
            maxSize: opts.maxWorkers,
            idleTimeoutMs: opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
        };
        if (opts.coreBudget !== undefined) {
            poolCtorOpts.coreBudget = opts.coreBudget;
        }
        if (opts.workerCost !== undefined) {
            poolCtorOpts.workerCost = opts.workerCost;
        }
        this.pool = new WorkerPool(poolCtorOpts);
        this.queue = new PriorityQueue();
        this.dedupe = new DedupeRegistry();
        this.admissionGate = opts.admissionGate;
        this.pushHwm = opts.pushHwm ?? DEFAULT_PUSH_HWM;
        this.maxParkedSessions = opts.maxParkedSessions ?? Infinity;
        if (opts.prewarmSize && opts.prewarmSize > 0) {
            this.pool.prewarm(opts.prewarmSize);
        }
    }
    // Helper to cleanly abort acquisition when aborted or cancelled mid-flight (S5)
    abortAcquisition(params, reason) {
        this.releaseAdmission(params.sessionId);
        if (params.sourceKey !== null) {
            // Notify active subscribers before completing primary
            const subs = this.dedupe.subscribers(params.sessionId);
            for (const sub of subs) {
                if (sub !== params.sessionId) {
                    const subRec = this.sessions.get(sub);
                    if (subRec !== undefined) {
                        for (const h of subRec.handlers) {
                            try {
                                h({ type: "decode_cancelled", sessionId: sub });
                            }
                            catch { }
                        }
                        this.cleanupSession(sub);
                    }
                }
            }
            this.dedupe.complete(params.sessionId); // removes key→primary mapping
        }
        throw new Error(reason);
    }
    // ---------------------------------------------------------------------------
    // Session acquisition — called by jxl-session to reserve a worker slot
    // ---------------------------------------------------------------------------
    async acquireSlot(params) {
        if (this.destroyed)
            throw new Error("[jxl-scheduler] Scheduler is shut down.");
        // Dedupe check: if a session for this sourceKey already exists, fan out.
        if (params.sourceKey !== null) {
            const primaryId = this.dedupe.findPrimary(params.sourceKey);
            if (primaryId !== null) {
                this.dedupe.subscribe(params.sessionId, primaryId);
                // Dedupe priority invariant: visible subscriber on background primary escalates primary.
                // Prevents visible view from inheriting background pacing or being preemptable.
                const primaryRecord = this.sessions.get(primaryId);
                if (primaryRecord !== undefined && params.priority === "visible" && primaryRecord.priority === "background") {
                    primaryRecord.priority = "visible";
                    if (primaryRecord.worker !== undefined)
                        this.backgroundWorkers.delete(primaryRecord.worker);
                    if (primaryRecord.state === "queued" && primaryRecord.pending !== undefined) {
                        this.queue.remove(primaryId, "background");
                        primaryRecord.pending.priority = "visible";
                        this.queue.enqueue({ priority: "visible", sessionId: primaryId, payload: primaryRecord.pending });
                    }
                }
                // Subscriber gets a lightweight record — handlers only, no worker/pending.
                this.sessions.set(params.sessionId, {
                    sessionId: params.sessionId,
                    state: "running",
                    priority: params.priority,
                    kind: params.startMsg.type === "encode_start" ? "encode" : "decode",
                    handlers: this.takePendingHandlers(params.sessionId),
                    createdAt: performance.now(),
                    progress: 0,
                    isSubscriber: true,
                });
                this._subscriberCount++;
                this.totalSessionCount++;
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
            if (this.destroyed)
                this.abortAcquisition(params, "[jxl-scheduler] Scheduler is shut down.");
            if (params.signal?.aborted)
                this.abortAcquisition(params, "[jxl-scheduler] Session aborted before assignment.");
            if (this.cancelledDuringAcquisition.has(params.sessionId)) {
                this.cancelledDuringAcquisition.delete(params.sessionId);
                this.abortAcquisition(params, "[jxl-scheduler] Session cancelled during acquisition.");
            }
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
        if (this.destroyed)
            this.abortAcquisition(params, "[jxl-scheduler] Scheduler is shut down.");
        if (params.signal?.aborted)
            this.abortAcquisition(params, "[jxl-scheduler] Session aborted before assignment.");
        if (this.cancelledDuringAcquisition.has(params.sessionId)) {
            this.cancelledDuringAcquisition.delete(params.sessionId);
            this.abortAcquisition(params, "[jxl-scheduler] Session cancelled during acquisition.");
        }
        if (worker !== null) {
            this.assignWorker(worker, params.sessionId, params.startMsg);
            this.setupSignalAbort(params.sessionId, params.signal);
            return { workerId: worker.id };
        }
        // No worker available — check for preemption opportunity.
        if (params.priority === "visible") {
            const preempted = await this.tryPreempt(params);
            if (this.destroyed)
                this.abortAcquisition(params, "[jxl-scheduler] Scheduler is shut down.");
            if (params.signal?.aborted)
                this.abortAcquisition(params, "[jxl-scheduler] Session aborted before assignment.");
            if (this.cancelledDuringAcquisition.has(params.sessionId)) {
                this.cancelledDuringAcquisition.delete(params.sessionId);
                this.abortAcquisition(params, "[jxl-scheduler] Session cancelled during acquisition.");
            }
            if (preempted !== null)
                return { workerId: preempted };
        }
        // Queue the session and wait for a slot.
        return new Promise((resolve, reject) => {
            const pending = {
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
    send(sessionId, msg, transfer = []) {
        const record = this.sessions.get(sessionId);
        if (record === undefined)
            return;
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
    onMessage(sessionId, handler) {
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
    /**
     * Viewport-driven real-time re-prioritization of an active session without canceling/restarting (S14).
     * Moves a queued session to the back of the new priority lane (same semantics as dedupe escalation),
     * or updates a running session's background Worker membership for preemption tracking.
     */
    setPriority(sessionId, priority) {
        const record = this.sessions.get(sessionId);
        if (record === undefined)
            return false;
        if (record.priority === priority)
            return true;
        const oldPriority = record.priority;
        record.priority = priority;
        if (record.state === "queued" && record.pending !== undefined) {
            this.queue.remove(sessionId, oldPriority);
            record.pending.priority = priority;
            this.queue.enqueue({ priority, sessionId: record.pending.sessionId, payload: record.pending });
        }
        else if (record.worker !== undefined) {
            if (priority === "background")
                this.backgroundWorkers.add(record.worker);
            else
                this.backgroundWorkers.delete(record.worker);
        }
        return true;
    }
    // ---------------------------------------------------------------------------
    // Session completion / cancellation
    // ---------------------------------------------------------------------------
    completeSession(sessionId) {
        this.cleanupSession(sessionId);
        this.drainQueue();
    }
    cancelSession(sessionId) {
        const record = this.sessions.get(sessionId);
        if (record === undefined) {
            this.dedupe.cancelSubscriber(sessionId);
            this.cancelledDuringAcquisition.add(sessionId);
            return false;
        }
        // Call cancelSubscriber up-front using priority-aware subscriber selection callback (D2)
        const { cancelWorker, promotedTo } = this.dedupe.cancelSubscriber(sessionId, (candidates) => {
            let best;
            let bestPriority = "background";
            for (const cand of candidates) {
                const r = this.sessions.get(cand);
                if (r !== undefined) {
                    if (r.priority === "visible") {
                        return cand; // visible is best, return immediately
                    }
                    if (r.priority === "near" && bestPriority === "background") {
                        best = cand;
                        bestPriority = "near";
                    }
                    else if (best === undefined) {
                        best = cand;
                    }
                }
            }
            return best;
        });
        if (promotedTo !== undefined) {
            // Primary was cancelled, but a subscriber was promoted (S4).
            // We must clean up the primary's record and rebind the worker/pending/paused state to the new primary.
            const promotedRecord = this.sessions.get(promotedTo);
            if (record.worker !== undefined && promotedRecord !== undefined) {
                // Transfer the worker to the promoted subscriber.
                promotedRecord.worker = record.worker;
                record.worker.activeSessionId = promotedTo;
                // Dedupe promotion can change priority (bg <-> visible); keep backgroundWorkers set correct for preemption eligibility.
                if (promotedRecord.priority === "background")
                    this.backgroundWorkers.add(record.worker);
                else
                    this.backgroundWorkers.delete(record.worker);
            }
            else if (record.pausedOnWorker !== undefined && promotedRecord !== undefined) {
                // Transfer paused state.
                promotedRecord.state = "paused";
                promotedRecord.pausedOnWorker = record.pausedOnWorker;
                this.workerPausedSession.set(record.pausedOnWorker.id, promotedTo);
            }
            else if (record.pending !== undefined && promotedRecord !== undefined) {
                // Transfer queue position if still pending.
                promotedRecord.state = "queued";
                promotedRecord.pending = record.pending;
                promotedRecord.pending.sessionId = promotedTo;
                // Update the queue entry
                this.queue.remove(sessionId, record.priority);
                this.queue.enqueue({ priority: promotedRecord.priority, sessionId: promotedTo, payload: promotedRecord.pending });
            }
            // Transfer gate admission (if held) to promoted so it is released when promoted work ends.
            const grel = this.gateReleases.get(sessionId);
            if (grel !== undefined && promotedRecord !== undefined) {
                this.gateReleases.delete(sessionId);
                this.gateReleases.set(promotedTo, grel);
            }
            // Old primary (record) leaves its bucket. Promoted former-sub leaves subscriber count and enters primary bucket.
            this.adjustSessionCount(record, -1);
            if (promotedRecord?.isSubscriber) {
                this._subscriberCount = Math.max(0, this._subscriberCount - 1);
                delete promotedRecord.isSubscriber;
                if (promotedRecord.state === "running" || promotedRecord.state === "cancelling")
                    this._runningCount++;
                else if (promotedRecord.state === "queued")
                    this._queuedCount++;
                else if (promotedRecord.state === "paused")
                    this._pausedCount++;
            }
            this.sessions.delete(sessionId);
            return true;
        }
        // No promotion (promotedTo === undefined). We are cancelling the actual work or a lone subscriber.
        if (!cancelWorker) {
            this.releaseAdmission(sessionId);
            this.adjustSessionCount(record, -1);
            this.sessions.delete(sessionId);
            return true;
        }
        // Paused: send cancel to the worker hosting the dormant decoder, notify caller,
        // clean up immediately. Register in discardSessions (S1).
        if (record.state === "paused" && record.pausedOnWorker !== undefined) {
            const w = record.pausedOnWorker;
            let ds = this.discardSessions.get(w.id);
            if (ds === undefined) {
                ds = new Set();
                this.discardSessions.set(w.id, ds);
            }
            ds.add(sessionId);
            this.workerPausedSession.delete(w.id);
            w.handle.send({ type: "decode_cancel", sessionId });
            delete record.pausedOnWorker;
            for (const h of record.handlers)
                h({ type: "decode_cancelled", sessionId });
            this.releaseAdmission(sessionId);
            this._pausedCount--;
            this.sessions.delete(sessionId);
            return true;
        }
        // Queued: remove from queue and reject the pending promise (S4).
        if (record.state === "queued" && record.pending !== undefined) {
            const removed = this.queue.remove(sessionId, record.priority);
            if (removed) {
                this.unblockBackpressure(record);
                record.pending.reject(new Error("[jxl-scheduler] Session cancelled."));
                this.releaseAdmission(sessionId);
                this._queuedCount--;
                this.sessions.delete(sessionId);
                return true;
            }
        }
        // Running primary: send cancel to worker. Keep record until worker acks
        // (terminal message arrives in handleWorkerMessage → cleanupSession).
        if (record.worker !== undefined) {
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
        }
        else {
            // No worker, no pending — orphaned. Clean up.
            this.releaseAdmission(sessionId);
            this.adjustSessionCount(record, -1);
            this.sessions.delete(sessionId);
        }
        return true;
    }
    // ---------------------------------------------------------------------------
    // Backpressure
    // ---------------------------------------------------------------------------
    async waitForDrain(sessionId) {
        const record = this.sessions.get(sessionId);
        if (record === undefined)
            return;
        if (record.backpressure === undefined) {
            record.backpressure = { queueDepth: 0, pendingPushes: [], pendingHead: 0 };
        }
        const bp = record.backpressure;
        bp.queueDepth++;
        if (bp.queueDepth < this.adaptiveHwm())
            return;
        return new Promise((resolve) => {
            bp.pendingPushes.push({ resolve, waitedAt: performance.now() });
        });
    }
    signalDrain(sessionId) {
        const bp = this.sessions.get(sessionId)?.backpressure;
        if (bp === undefined)
            return;
        bp.queueDepth = Math.max(0, bp.queueDepth - 1);
        const hwm = this.adaptiveHwm();
        if (bp.pendingHead < bp.pendingPushes.length) {
            // Resolve as many waiters as needed to keep queue depth below adaptive HWM (S13)
            while (bp.queueDepth < hwm && bp.pendingHead < bp.pendingPushes.length) {
                const waiter = bp.pendingPushes[bp.pendingHead++];
                this.updateDrainEma(performance.now() - waiter.waitedAt);
                waiter.resolve();
                bp.queueDepth = Math.max(0, bp.queueDepth - 1);
            }
        }
        else {
            // No waiter: drains are keeping up; decay EMA toward neutral so HWM recovers (S12)
            this.drainLatencyEma += (50 - this.drainLatencyEma) * 0.05;
        }
        // Compact when head has consumed the whole array.
        if (bp.pendingHead >= bp.pendingPushes.length) {
            bp.pendingPushes.length = 0;
            bp.pendingHead = 0;
        }
        else if (bp.pendingHead >= 1024) {
            bp.pendingPushes.copyWithin(0, bp.pendingHead);
            bp.pendingPushes.length -= bp.pendingHead;
            bp.pendingHead = 0;
        }
    }
    // Scale HWM up when draining fast, down when slow.
    // At 50ms EMA (init): factor ≈ 1 → HWM = pushHwm (neutral).
    // At 10ms: factor = 2 (capped) → HWM = pushHwm * 2, up to pushHwm * 2 (default 8).
    // At 200ms: factor = 0.25 (floor) → HWM = max(2, pushHwm * 0.25).
    adaptiveHwm() {
        const factor = Math.max(0.25, Math.min(2, 50 / (this.drainLatencyEma + 1)));
        return Math.max(2, Math.round(this.pushHwm * factor));
    }
    updateDrainEma(latencyMs) {
        this.drainLatencyEma = this.DRAIN_EMA_ALPHA * latencyMs + (1 - this.DRAIN_EMA_ALPHA) * this.drainLatencyEma;
    }
    // Unblock all pending waitForDrain calls — used on cancel/shutdown so callers don't hang.
    unblockBackpressure(record) {
        if (record.backpressure === undefined)
            return;
        const { pendingPushes, pendingHead } = record.backpressure;
        for (let i = pendingHead; i < pendingPushes.length; i++) {
            pendingPushes[i].resolve();
        }
        delete record.backpressure;
    }
    // ---------------------------------------------------------------------------
    // Metrics
    // ---------------------------------------------------------------------------
    /**
     * Returns a shallow-cloned, frozen snapshot of scheduler metrics counters (S16).
     * Decouples callers from internal mutable state. The returned object may be
     * retained across async boundaries; later mutations to scheduler (counters,
     * queue transitions, preemption counts) will not be visible to holders.
     * Freezing prevents receivers from mutating the snapshot they received.
     * Architectural guard for sched-4 (Metric Object Copy Protection).
     */
    getMetrics() {
        const snapshot = {
            running: this._runningCount,
            queued: this._queuedCount,
            paused: this._pausedCount,
            background: this.backgroundWorkers.size,
            preemptions: this.preemptionCount,
            totalSessions: this.totalSessionCount,
            subscribers: this._subscriberCount,
            drainLatencyEmaMs: this.drainLatencyEma,
            effectiveHwm: this.adaptiveHwm(),
            poolSize: this.pool.size,
            poolIdle: this.pool.idleCount,
            poolParked: this.pool.parkedCount,
            poolSpawning: this.pool.spawningCount,
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
     * Supports an optional stampSessionId parameter performing one spread + freeze (S16).
     */
    protectMetricForDispatch(msg, stampSessionId) {
        const rawMsg = msg;
        const targetSessionId = stampSessionId ?? rawMsg.sessionId;
        if (rawMsg.type !== "metric") {
            if (stampSessionId !== undefined && rawMsg.sessionId !== stampSessionId) {
                return { ...msg, sessionId: stampSessionId };
            }
            return msg;
        }
        const clonedMetric = Object.freeze({ ...rawMsg.metric });
        const protectedMsg = Object.freeze({ ...msg, sessionId: targetSessionId, metric: clonedMetric });
        return protectedMsg;
    }
    // Route count adjustment for a record. Subscribers are tracked separately from
    // primary running/queued/paused so that "running" accurately reflects worker assignments.
    adjustSessionCount(record, delta) {
        if (record === undefined)
            return;
        if (record.isSubscriber) {
            this._subscriberCount = Math.max(0, this._subscriberCount + delta);
            return;
        }
        if (record.state === "running" || record.state === "cancelling") {
            this._runningCount = Math.max(0, this._runningCount + delta);
        }
        else if (record.state === "queued") {
            this._queuedCount = Math.max(0, this._queuedCount + delta);
        }
        else if (record.state === "paused") {
            this._pausedCount = Math.max(0, this._pausedCount + delta);
        }
    }
    // ---------------------------------------------------------------------------
    // Preemption (Section 12.2)
    // ---------------------------------------------------------------------------
    async tryPreempt(params) {
        const backgroundWorker = this.findBackgroundWorker();
        if (backgroundWorker === null)
            return null;
        const victimSessionId = backgroundWorker.activeSessionId;
        const victimRecord = this.sessions.get(victimSessionId);
        const victimKind = victimRecord?.kind ?? "decode";
        // Decode victims are paused (WASM state preserved for resume).
        // Encode victims are cancelled (no in-progress state worth preserving).
        const usePause = victimKind === "decode";
        backgroundWorker.cancelling = true;
        const prevHandlers = victimRecord?.handlers ?? [];
        let ackResolved = false;
        let resolvedKind = null;
        const ack = new Promise((resolve) => {
            const handler = (msg) => {
                // Match terminal messages in the pause branch too (S2)
                const matched = usePause
                    ? ((msg.type === "decode_paused" && msg.sessionId === victimSessionId)
                        || (this.isTerminalMessage(msg) && msg.sessionId === victimSessionId))
                    : ((msg.type === "decode_cancelled" || msg.type === "encode_cancelled") && msg.sessionId === victimSessionId)
                        || (this.isTerminalMessage(msg) && msg.sessionId === victimSessionId);
                if (matched) {
                    ackResolved = true;
                    if (usePause && msg.type === "decode_paused")
                        resolvedKind = "paused";
                    else if (!usePause && (msg.type === "decode_cancelled" || msg.type === "encode_cancelled"))
                        resolvedKind = "cancelled";
                    else if (this.isTerminalMessage(msg))
                        resolvedKind = "terminal";
                    resolve();
                    if (victimRecord)
                        prevHandlers.shift();
                }
            };
            if (victimRecord)
                prevHandlers.unshift(handler);
            if (usePause) {
                backgroundWorker.handle.send({ type: "decode_pause", sessionId: victimSessionId });
            }
            else if (victimKind === "encode") {
                backgroundWorker.handle.send({ type: "encode_cancel", sessionId: victimSessionId, reason: "preempted" });
            }
            else {
                backgroundWorker.handle.send({ type: "decode_cancel", sessionId: victimSessionId, reason: "preempted" });
            }
        });
        // 2-second timeout prevents indefinite wait on an unresponsive worker.
        let timeout;
        try {
            await Promise.race([
                ack,
                new Promise((_, reject) => {
                    timeout = setTimeout(() => reject(new Error("preempt-timeout")), 2000);
                }),
            ]);
        }
        catch {
            if (victimRecord)
                prevHandlers.shift();
            this.pool.recycle(backgroundWorker);
        }
        finally {
            clearTimeout(timeout);
        }
        backgroundWorker.cancelling = false;
        if (resolvedKind === "terminal") {
            // Victim finished naturally (decode_final etc) in the window between selection and preemption signal.
            // Normal handleWorkerMessage already cleaned the victim and released the worker to pool.
            // Do not park/cancel or double-clean; acquire via fallback (may reclaim the just-released worker).
            const newWorker = await this.pool.acquire();
            if (newWorker !== null) {
                this.assignWorker(newWorker, params.sessionId, params.startMsg);
                this.setupSignalAbort(params.sessionId, params.signal);
                this.preemptionCount++;
                return newWorker.id;
            }
            return null;
        }
        if (!ackResolved) {
            // Timed out: worker recycled (pool.recycle terminates it). The terminal
            // decode_cancelled from the worker may never arrive (activeSessionId is
            // cleared during teardown, so handleWorkerMessage silently drops it).
            // Synthesize terminal for victim's handlers so their done()/streams do not hang forever.
            const victimHandlers = this.sessions.get(victimSessionId)?.handlers ?? [];
            const cancelType = victimKind === "encode" ? "encode_cancelled" : "decode_cancelled";
            const cancelMsg = { type: cancelType, sessionId: victimSessionId };
            for (const h of victimHandlers) {
                try {
                    h(cancelMsg);
                }
                catch { /* handler must not throw */ }
            }
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
            // Bound parked decoder memory (S15)
            if (this.workerPausedSession.size > this.maxParkedSessions) {
                let oldestRecord;
                for (const pid of this.workerPausedSession.values()) {
                    const r = this.sessions.get(pid);
                    if (r !== undefined && r.state === "paused") {
                        if (oldestRecord === undefined || r.createdAt < oldestRecord.createdAt) {
                            oldestRecord = r;
                        }
                    }
                }
                if (oldestRecord !== undefined) {
                    this.cancelSession(oldestRecord.sessionId);
                }
            }
            if (!backgroundWorker.handle.terminated) {
                this.assignWorker(backgroundWorker, params.sessionId, params.startMsg);
                this.setupSignalAbort(params.sessionId, params.signal);
                this.preemptionCount++;
                return backgroundWorker.id;
            }
            // Worker died between ack and reassign (rare). If paused, clean up the parked session.
            this.workerPausedSession.delete(backgroundWorker.id);
            if (victimRecord !== undefined) {
                // paused → cancelling (counts as running for metrics)
                this._pausedCount--;
                this._runningCount++;
                victimRecord.state = "cancelling";
                delete victimRecord.pausedOnWorker;
            }
            this.releaseSession(victimSessionId);
            const newWorker = await this.pool.acquire();
            if (newWorker !== null) {
                this.assignWorker(newWorker, params.sessionId, params.startMsg);
                this.setupSignalAbort(params.sessionId, params.signal);
                this.preemptionCount++;
                return newWorker.id;
            }
            return null;
        }
        else {
            // encode_cancelled is terminal: handleWorkerMessage already cleaned the victim
            // and released (possibly reassigned) the worker. Acquire through the pool (S3).
            this.releaseSession(victimSessionId); // defensive no-op
            const newWorker = await this.pool.acquire();
            if (newWorker !== null) {
                this.assignWorker(newWorker, params.sessionId, params.startMsg);
                this.setupSignalAbort(params.sessionId, params.signal);
                this.preemptionCount++;
                return newWorker.id;
            }
            return null;
        }
    }
    // Score a candidate preemption victim. Lower score = better victim.
    // Prefer sessions with low progress (less re-work on resubmit) and low age
    // (less wall-clock time invested). Age is normalised to [0,1] to keep it
    // on the same scale as progress.
    scoreVictim(record) {
        const ageNorm = Math.min(1, (performance.now() - record.createdAt) / this.PREEMPT_AGE_NORM_MS);
        return record.progress * this.PREEMPT_PROGRESS_W
            + ageNorm * this.PREEMPT_AGE_W
            + (record.kind === "encode" ? this.PREEMPT_ENCODE_W : 0);
    }
    findBackgroundWorker() {
        let bestWorker = null;
        let bestScore = Infinity;
        for (const worker of this.backgroundWorkers) {
            if (worker.cancelling || worker.activeSessionId === null)
                continue;
            // Skip workers already holding a paused session — their decoder slot is occupied.
            if (this.workerPausedSession.has(worker.id))
                continue;
            const record = this.sessions.get(worker.activeSessionId);
            if (record === undefined)
                continue;
            // Dedupe priority: if primary or any subscriber is visible, this worker is not a preemption victim.
            // A visible consumer attached via fan-out "escalates" the session for preemption eligibility.
            let hasVisible = record.priority === "visible";
            if (!hasVisible) {
                this.dedupe.forEachSubscriber(worker.activeSessionId, (sid) => {
                    const sr = this.sessions.get(sid);
                    if (sr?.priority === "visible")
                        hasVisible = true;
                });
            }
            if (hasVisible)
                continue;
            const score = this.scoreVictim(record);
            if (score < bestScore) {
                bestScore = score;
                bestWorker = worker;
            }
        }
        return bestWorker;
    }
    // Resume a paused session on the worker that holds its decoder state.
    resumePausedSession(worker, sessionId) {
        const record = this.sessions.get(sessionId);
        if (worker.handle.terminated || record === undefined || record.state !== "paused") {
            if (record !== undefined && record.state === "paused") {
                for (const h of record.handlers) {
                    try {
                        h({ type: "decode_cancelled", sessionId });
                    }
                    catch { }
                }
                this.cleanupSession(sessionId);
            }
            else if (!worker.handle.terminated) {
                this.pool.release(worker);
            }
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
        if (record.priority === "background")
            this.backgroundWorkers.add(worker);
        else
            this.backgroundWorkers.delete(worker);
        this.ensureWorkerWired(worker);
        worker.handle.send({ type: "decode_resume", sessionId });
    }
    // ---------------------------------------------------------------------------
    // Assignment helpers
    // ---------------------------------------------------------------------------
    assignWorker(worker, sessionId, startMsg) {
        this.pool.bind(worker, sessionId);
        // Derive priority from current record status to pick up dedupe escalation (S8)
        const existing = this.sessions.get(sessionId);
        const priority = existing?.priority ?? startMsg.priority;
        const kind = startMsg.type === "encode_start" ? "encode" : "decode";
        // Queued → running transition: update existing record in-place.
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
                    type: "metric",
                    sessionId,
                    metric: { name: "scheduler_queue_wait_ms", value: waitMs },
                };
                for (const h of existing.handlers) {
                    try {
                        h(this.protectMetricForDispatch(metricMsg, sessionId));
                    }
                    catch { /* handler must not throw */ }
                }
            }
            delete existing.queuedAt;
        }
        else {
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
        if (priority === "background")
            this.backgroundWorkers.add(worker);
        else
            this.backgroundWorkers.delete(worker);
        // Wire the worker's message callback exactly once per worker lifetime —
        // prevents stale closures accumulating across session reuse.
        this.ensureWorkerWired(worker);
        worker.handle.send(startMsg);
    }
    ensureWorkerWired(worker) {
        if (this.wiredWorkers.has(worker))
            return;
        this.wiredWorkers.add(worker);
        worker.handle.onMessage((msg) => {
            // S1: Filter stale sessions per worker at the wire before restamping
            const raw = msg.sessionId;
            if (raw !== undefined) {
                const ds = this.discardSessions.get(worker.id);
                if (ds?.has(raw)) {
                    if (this.isTerminalMessage(msg)) { // ack consumed; stop discarding
                        ds.delete(raw);
                        if (ds.size === 0)
                            this.discardSessions.delete(worker.id);
                    }
                    return;
                }
            }
            const sessionId = worker.activeSessionId;
            if (sessionId === null || sessionId === RESERVED_SESSION_ID)
                return;
            this.handleWorkerMessage(sessionId, worker, msg);
        });
    }
    static STAGE_PROGRESS = {
        header: 0.1,
        dc: 0.3,
        pass: 0.6,
        final: 0.95,
    };
    handleWorkerMessage(sessionId, worker, rawMsg) {
        // Re-stamp the message with the scheduler's current active session ID.
        // This is critical if the worker was promoted to a new primary, as the worker
        // itself is unaware of the JS-side session ID change.
        // Guard the spread: only allocate when the embedded id differs (hot path optimisation).
        const msg = rawMsg.sessionId === sessionId
            ? rawMsg
            : { ...rawMsg, sessionId };
        const record = this.sessions.get(sessionId);
        const handlers = record?.handlers ?? EMPTY_HANDLERS;
        for (const h of handlers)
            h(this.protectMetricForDispatch(rawMsg, sessionId));
        // Fan out to dedupe subscribers.
        this.dedupe.forEachSubscriber(sessionId, (subId) => {
            if (subId === sessionId)
                return;
            const subRecord = this.sessions.get(subId);
            const subHandlers = subRecord?.handlers ?? EMPTY_HANDLERS;
            for (const h of subHandlers)
                h(this.protectMetricForDispatch(rawMsg, subId));
        });
        // Track decode progress for victim scoring. The stage is used as a proxy for
        // fractional completion so that nearly-done sessions are spared from preemption.
        if (record !== undefined && msg.type === "decode_progress") {
            const p = Scheduler.STAGE_PROGRESS[msg.stage];
            if (p !== undefined)
                record.progress = Math.max(record.progress, p);
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
            }
            else {
                this.pool.release(worker);
                this.drainQueue();
            }
        }
    }
    isTerminalMessage(msg) {
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
    setupSignalAbort(sessionId, signal) {
        if (signal === null)
            return;
        const rec = this.sessions.get(sessionId);
        if (rec?.abortCleanup !== undefined)
            return; // already wired (S6)
        if (signal.aborted) {
            this.cancelSession(sessionId);
            return;
        }
        const onAbort = () => this.cancelSession(sessionId);
        signal.addEventListener("abort", onAbort, { once: true });
        if (rec)
            rec.abortCleanup = () => signal.removeEventListener("abort", onAbort);
    }
    takePendingHandlers(sessionId) {
        const handlers = this.pendingHandlers.get(sessionId);
        if (handlers === undefined)
            return [];
        this.pendingHandlers.delete(sessionId);
        return handlers;
    }
    // Release the AdmissionGate slot (if any) for this sessionId (sched-2).
    releaseAdmission(sessionId) {
        const rel = this.gateReleases.get(sessionId);
        if (rel !== undefined) {
            this.gateReleases.delete(sessionId);
            try {
                rel();
            }
            catch { /* releases must not propagate */ }
        }
    }
    releaseAllAdmissions() {
        for (const [, rel] of this.gateReleases) {
            try {
                rel();
            }
            catch { /* releases must not propagate */ }
        }
        this.gateReleases.clear();
    }
    // Tears down session state without triggering a queue drain.
    cleanupSession(sessionId) {
        this.releaseAdmission(sessionId);
        const record = this.sessions.get(sessionId);
        if (record !== undefined) {
            this.adjustSessionCount(record, -1);
            record.abortCleanup?.();
            this.unblockBackpressure(record); // unblock backpressure waiters (S7)
        }
        this.releaseSession(sessionId);
        this.dedupe.complete(sessionId);
        this.sessions.delete(sessionId);
        this.pendingHandlers.delete(sessionId);
    }
    releaseSession(sessionId) {
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
    drainQueue() {
        if (this.queue.isEmpty || this.drainingQueue)
            return;
        this.drainingQueue = true;
        // Sync fast path: drain all entries that have an immediately available idle
        // worker, skipping the async hop (Promise allocation + microtask scheduling).
        // Common steady-state case: a worker just finished, queue has work, pool has
        // an idle slot — no need for an async round-trip.
        while (!this.queue.isEmpty) {
            const worker = this.pool.tryAcquireIdle();
            if (worker === null)
                break;
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
        if (this.queue.isEmpty) {
            this.drainingQueue = false;
            return;
        }
        // Async path: no idle workers available; wait for spawn or worker release.
        void (async () => {
            try {
                while (!this.queue.isEmpty) {
                    const worker = await this.pool.acquire();
                    if (worker === null)
                        break;
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
            }
            catch (err) {
                console.error("[jxl-scheduler] drainQueue error:", err);
                setTimeout(() => this.drainQueue(), 50);
            }
            finally {
                this.drainingQueue = false;
            }
        })();
    }
    // ---------------------------------------------------------------------------
    // Shutdown
    // ---------------------------------------------------------------------------
    async shutdown() {
        this.destroyed = true;
        // Reject/notify all non-running sessions so their callers don't hang.
        const shutdownErr = new Error("[jxl-scheduler] Scheduler shut down.");
        for (const record of this.sessions.values()) {
            if (record.state === "queued" && record.pending !== undefined) {
                this.unblockBackpressure(record);
                record.pending.reject(shutdownErr);
            }
            else if (record.state === "paused") {
                // Notify paused-session callers with a synthetic cancelled message.
                for (const h of record.handlers)
                    h({ type: "decode_cancelled", sessionId: record.sessionId });
            }
            else if (record.state === "running" || record.state === "cancelling") {
                // Running sessions lose their workers on pool.shutdown(); synthesize terminal so callers do not hang.
                const t = record.kind === "encode" ? "encode_cancelled" : "decode_cancelled";
                for (const h of record.handlers) {
                    try {
                        h({ type: t, sessionId: record.sessionId });
                    }
                    catch { }
                }
            }
        }
        this.releaseAllAdmissions();
        await this.pool.shutdown();
        this._runningCount = 0;
        this._queuedCount = 0;
        this._pausedCount = 0;
        this._subscriberCount = 0;
        this.sessions.clear();
        this.backgroundWorkers.clear();
        this.workerPausedSession.clear();
        this.discardSessions.clear();
        this.cancelledDuringAcquisition.clear();
        this.gateReleases.clear();
    }
}
//# sourceMappingURL=scheduler.js.map