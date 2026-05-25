# Working Notes: packages/jxl-scheduler/src/scheduler.ts
> Core scheduler — priority lanes, preemption, dedup, backpressure, session lifecycle
> Feature covered: #2 (Advanced Scheduling & Flow Control)

---

## Index of Key API

| Symbol | Kind | Purpose |
|--------|------|---------|
| `Scheduler` | class | Main scheduling entry point |
| `acquireSlot()` | async method | Reserve a worker for a new session; handles dedup fan-out and preemption |
| `send()` | method | Fire-and-forget message forward; buffers if queued, paused, or running |
| `onMessage()` | method | Register a handler — returns void (no unsubscribe, per protocol) |
| `waitForDrain()` | async method | Backpressure gate — blocks when queueDepth ≥ adaptiveHwm() |
| `cancelSession()` | method | Handles queued/running/paused/subscriber states distinctly |
| `completeSession()` | method | Cleanup + queue drain |
| `getMetrics()` | method | running/queued/paused/background/preemptions/totalSessions |
| `shutdown()` | async method | Drains queue, rejects/notifies all sessions, shuts pool down |

---

## Feature #2 Coverage

| Feature | Status | Location |
|---------|--------|---------|
| Prioritized Task Lanes | ✅ Full | `PriorityQueue<PendingSession>` with visible/near/background tiers |
| Preemption with Pause/Resume | ✅ Full | `tryPreempt()`: sends `decode_pause`, awaits `decode_paused` ack, parks as `"paused"` state; `resumePausedSession()` re-attaches when worker is free |
| Deduplication (Fan-out) | ✅ Full | `DedupeRegistry.subscribe()` — single cancel doesn't kill primary; `forEachSubscriber` fans out messages |
| Integrated Backpressure | ✅ Full | `waitForDrain()` / `signalDrain()` — pushes block when depth ≥ adaptiveHwm() |
| Adaptive Drain HWM | ✅ Full | `adaptiveHwm()` = `pushHwm × clamp(50/(ema+1), 0.25, 2)` — scales with actual drain latency |
| Pool Pre-warming | ✅ Delegated | `opts.prewarmSize → pool.prewarm(n)` |
| Input Queue Safety Cap | ✅ Full | Backpressure HWM enforces per-session input cap |
| `onPause` Idempotency | ✅ Full | Pause-guard in `tryPreempt`: `ackResolved` flag; handlers restored atomically |
| Zombie-Start Prevention | ✅ Full | `setupSignalAbort()`: if signal already aborted before registration, `cancelSession` runs synchronously |
| Pre-Aborted Signal Handling | ✅ Full | Same `setupSignalAbort()` checks `signal.aborted` first |
| Terminal-State Wakeup | ✅ Full | `unblockBackpressure()` called on cancel and shutdown; paused sessions get synthetic `decode_cancelled` on shutdown |
| Victim Scoring | ✅ Full | `scoreVictim()`: lower progress + younger = better victim (minimises re-work) |
| 2s Preemption Timeout | ✅ Full | `Promise.race([ack, setTimeout(2000)])` — unresponsive worker gets recycled |
| `send()` fire-and-forget | ✅ Full | Returns void, no throw on missing session |
| `onMessage()` returns void | ✅ Full | No unsubscribe function returned |
| Cross-Type Session Guard | ✅ Full | `kind` tracked in `SessionRecord`; pause only for decode victims |

---

## Bottlenecks & Issues

### 🟢 B1 — `drainQueue` errors now caught, logged, and retried ✅ FIXED (G7)
**Status: FIXED** — The `catch` block in `drainQueue` now calls `console.error("[jxl-scheduler] drainQueue error:", err)` and `setTimeout(() => this.drainQueue(), 50)`. Errors are no longer silently consumed; queued sessions will resume draining after 50ms on failure.
Verified: 2026-05-25

### 🟡 B2 — Dedupe subscriber gets workerId = -1 when primary is still queued
`acquireSlot` for a subscriber returns `primaryRecord?.worker?.id ?? -1`. If the primary hasn't been assigned a worker yet (still queued), workerId is -1. Callers should tolerate -1 as "unknown/pending" — verify decode-session.ts handles this.

### 🟡 B3 — `drainQueue` is serial (one worker per iteration)
If many sessions are queued and multiple workers become idle simultaneously (e.g., after a batch completion), each `pool.acquire()` is awaited sequentially. Workers freed in the same tick may cause multiple separate drain iterations rather than one batch assignment.
**Impact:** Low — each acquired worker is immediately assigned, so total assignment is correct but may take a few more microtask ticks.

### 🟢 B4 — `backgroundWorkers` Set enables O(n_background) preemption scan
Rather than O(n_all_sessions), the preemption candidate scan iterates only the background workers set. This is a meaningful optimization for pools with many near/visible sessions alongside a few background ones.

---

## Key Invariants

- `SessionRecord` consolidates worker/pending/handlers/backpressure/priority/kind into one map entry — no split-brain between multiple maps.
- `wiredWorkers` WeakSet ensures each worker's onMessage callback is wired exactly once — prevents stale-closure accumulation across session reuse.
- Paused session: `record.state === "paused"`, `record.worker` deleted, `record.pausedOnWorker` set. `send()` forwards to `pausedOnWorker` so chunks queue in the worker's handler.
- `STAGE_PROGRESS` mapping: header=0.1, dc=0.3, pass=0.6, final=0.95. Used as monotonically-increasing proxy for victim scoring.
- `EMPTY_HANDLERS` shared const avoids per-message allocation when no handlers registered.
- Preemption timeout: if it fires, victim session is released, old worker recycled, new worker acquired fresh — no zombie sessions.
