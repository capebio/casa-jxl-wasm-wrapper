# 22-Lens Review — jxl-scheduler: scheduler.ts / pool.ts / queue.ts / budget.ts / dedupe.ts / types.ts

Date: 2026-06-12. Branch: Parallel-Wasm-Lens.
Scope: `packages/jxl-scheduler/src/{scheduler,pool,queue,budget,dedupe,types}.ts` only.
Six agent handoffs, one file each. Each handoff is self-contained.

**Cross-cutting rules for every agent:**
- Check `docs/rejected optimizations.md` before implementing; do not re-introduce rejected items (pixel buffer pools, drain callbacks on JxlDecoder, batch logic in session/facade, per-stage budget reset, compactQueue threshold < 64, sparse pre-allocated queues, soft-yield preemption).
- Layer invariants (CLAUDE.md): backpressure lives at scheduler/worker boundary; dedupe lives in scheduler; preemption is scheduler-only; `scheduler.send()` is fire-and-forget; `onMessage` returns void.
- Tests live in `packages/jxl-scheduler/test/` (compiled copies in `dist-test/`). Run the scheduler test suite after each fix; add a regression test per P0/P1.

---

## Priority index

| ID | File | Sev | Summary |
|----|------|-----|---------|
| S1 | scheduler.ts | **P0** | Blind sessionId re-stamp misroutes dormant-decoder acks → terminal delivered to the wrong (active) session |
| S2 | scheduler.ts | **P0** | Pause-preempt ack matcher misses natural terminal → healthy/reassigned worker recycled after 2s timeout |
| S3 | scheduler.ts | **P0** | Encode-victim preemption double-handles the worker; `pool.bind` throws on every encode preemption |
| S4 | scheduler.ts | P1 | Dedupe promotion result ignored in queued/paused cancel branches → promoted subscribers orphaned, hang forever |
| S5 | scheduler.ts | P1 | Dedupe registration + admission not cleaned on destroy/abort mid-acquisition → phantom primaries; ghost session runs after cancel-during-admission |
| S6 | scheduler.ts | P1 | `setupSignalAbort` re-registered on queued→running → abort-listener leak on long-lived signals |
| S7 | scheduler.ts | P1 | `cleanupSession` never unblocks backpressure waiters → pusher hangs after decode_error/decode_final |
| S8 | scheduler.ts | P2 | `assignWorker` uses stale `startMsg.priority`, ignoring dedupe escalation → wrong `backgroundWorkers` membership + wrong metrics |
| S9 | scheduler.ts | P2 | `resumePausedSession` calls `pool.bind` on possibly terminated worker → throws inside message handler |
| S10 | scheduler.ts | P2 | Victim scoring ignores kind: encode victims (work destroyed) preferred over decode victims (work preserved) |
| S11 | scheduler.ts | P2 | Header comment states budget is "per-stage" — contradicts CLAUDE.md session-level contract (doc fix) |
| S12 | scheduler.ts | P2 | Drain-latency EMA only updates on blocked pushes → HWM stays shrunk after one slow episode (benchmark-gated) |
| S13 | scheduler.ts | P2 | Verify worker_drain coalescing contract vs. one-resolve-per-drain accounting (investigate; fix only if confirmed) |
| S14 | scheduler.ts | P3 | Feature: `setPriority(sessionId, priority)` — viewport-driven re-prioritization without cancel/restart |
| S15 | scheduler.ts | P3 | Feature: `maxParkedSessions` cap (implements the in-code TODO at the `workerPausedSession` comment) |
| S16 | scheduler.ts | P3 | Fuse the double clone for subscriber metric fan-out; expose pool gauges in `getMetrics()` |
| P1 | pool.ts | P1 | Spawn-timeout leaks the late-resolving WorkerHandle (real Web Worker never shut down) |
| P2 | pool.ts | P3 | `parked ∩ idle` defensive branches in `takeIdleWorker`/`reapIdle` are dead per invariants — verify, convert to DEV assert |
| P3 | pool.ts | P3 | DEV invariant checks never run in browsers without bundler-defined `process.env.NODE_ENV` (document or widen detection) |
| Q1 | queue.ts | P3 | `remove()` scans all three lanes; caller knows the lane — add priority hint |
| Q2 | queue.ts | P3 | Per-lane size getters for observability; verify `peek()`/`backgroundIds()` are used anywhere |
| B1 | budget.ts | P2 | `acquire(cost > capacity)` hangs forever — guard |
| B2 | budget.ts | P3 | Expose `pendingCount`; DEV warning on over-release (cap currently masks double-release bugs) |
| D1 | dedupe.ts | P2 | `complete()` called on a subscriber id leaves dangling registry entries until primary completes |
| D2 | dedupe.ts | P3 | Promotion picks arbitrary subscriber — allow scheduler to prefer visible |
| T1 | types.ts | P3 | Dead `Session` interface; `WorkerHandle` lacks the optional `onError`/`onExit` members pool.ts already probes for |

---

## Agent 1 — scheduler.ts

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article.

File: `packages/jxl-scheduler/src/scheduler.ts`. Context you need: a worker that hosts a *paused* (parked) decoder is simultaneously *active* for a new session — `tryPreempt`'s pause path parks the victim's decoder in the worker heap, then rebinds the same worker to the preempting session (`park`/`unpark`/`RESERVED_SESSION_ID` dance at ~line 760). Messages from that worker can therefore originate from **two** logical sessions.

### S1 (P0) — Blind re-stamp misroutes dormant-decoder acks

`ensureWorkerWired` attributes every message to `worker.activeSessionId`, and `handleWorkerMessage` re-stamps `rawMsg.sessionId` to match. When `cancelSession` cancels a *paused* session X parked on worker W (which is actively running session Y), it sends `decode_cancel(X)` to W and deletes X's record, with a comment claiming the later `decode_cancelled` ack "is silently dropped". It is **not** dropped: the wired callback stamps it with `W.activeSessionId === Y`, `isTerminalMessage` matches, and the scheduler tears down the *live* session Y — cleanup, worker release, terminal fan-out to Y's consumers. A user cancelling a backgrounded thumbnail can kill the visible decode sharing that worker.

Fix: track stale session ids per worker and drop their traffic at the wire, *before* re-stamping:

```ts
// field
private readonly discardSessions = new Map<number, Set<string>>(); // workerId → stale ids

// cancelSession, paused branch, BEFORE this.sessions.delete(sessionId):
const w = record.pausedOnWorker;
let ds = this.discardSessions.get(w.id);
if (ds === undefined) { ds = new Set(); this.discardSessions.set(w.id, ds); }
ds.add(sessionId);

// ensureWorkerWired:
worker.handle.onMessage((msg) => {
  const raw = (msg as { sessionId?: string }).sessionId;
  if (raw !== undefined) {
    const ds = this.discardSessions.get(worker.id);
    if (ds?.has(raw)) {
      if (this.isTerminalMessage(msg)) {           // ack consumed; stop discarding
        ds.delete(raw);
        if (ds.size === 0) this.discardSessions.delete(worker.id);
      }
      return;
    }
  }
  const sessionId = worker.activeSessionId;
  if (sessionId === null || sessionId === RESERVED_SESSION_ID) return;
  this.handleWorkerMessage(sessionId, worker, msg);
});
```

Also clear `discardSessions` in `shutdown()`. Note the legitimate use of re-stamping (dedupe promotion rebinds a worker to a new primary while the decoder still emits the old wire id) must keep working — the discard set only contains explicitly cancelled paused ids, so promotion is unaffected. Regression test: park X via preemption, cancel X, then assert Y still completes with `decode_final` (test gap is also listed in CLAUDE.md: "Cancel while paused").

### S2 (P0) — Pause ack matcher misses natural terminal

In `tryPreempt`, the ack matcher for `usePause` accepts **only** `decode_paused`. The cancel branch correctly also accepts terminal messages. If the decode victim finishes naturally (`decode_final`) in the window between victim selection and the worker processing `decode_pause`, the ack never matches; normal terminal handling cleans the victim, **releases the worker to the pool, and `drainQueue` may immediately rebind it to a queued session**. After the 2-second timeout, the catch block calls `this.pool.recycle(backgroundWorker)` — terminating a worker that is now healthy and possibly running someone else's session.

Fix — match terminals in the pause branch too (the existing `resolvedKind` chain already handles `"terminal"` correctly):

```ts
const matched = usePause
  ? ((msg.type === "decode_paused" && msg.sessionId === victimSessionId)
      || (this.isTerminalMessage(msg) && msg.sessionId === victimSessionId))
  : ((msg.type === "decode_cancelled" || msg.type === "encode_cancelled") && msg.sessionId === victimSessionId)
    || (this.isTerminalMessage(msg) && msg.sessionId === victimSessionId);
```

Regression test: emit `decode_final` for the victim right after `findBackgroundWorker` selection; assert no recycle and the preempter acquires via the terminal path.

### S3 (P0) — Encode-victim preemption always throws

For encode victims (`usePause === false`), the awaited ack is `encode_cancelled` — which **is** a terminal message. `handleWorkerMessage` therefore runs full terminal handling synchronously before `tryPreempt` resumes: `cleanupSession(victim)` + `pool.release(worker)` + `drainQueue()` (which may rebind the worker). `tryPreempt` then executes `assignWorker(backgroundWorker, …)` → `pool.bind` → throws `"expected reserved state, got null"` (or the id of a drainQueue-assigned session). Every encode preemption rejects the visible caller's `acquireSlot`.

Fix — after a cancelled ack, never rebind the worker directly; go through the pool like the `"terminal"` path does:

```ts
} else {
  // encode_cancelled is terminal: handleWorkerMessage already cleaned the victim
  // and released (possibly reassigned) the worker. Acquire through the pool.
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
```

After this change the trailing `if (!backgroundWorker.handle.terminated)` block (lines ~774–800) becomes unreachable for the cancel path and the `if (usePause)` dead-worker subcase remains only reachable from the pause path's fall-through — restructure so the pause path's worker-died handling is kept and the rest deleted. Add an encode-preemption test (the existing `scheduler.preemption.test` appears to cover decode only — verify).

### S4 (P1) — Dedupe promotion ignored in queued/paused cancel branches

`cancelSession`'s early-return branches for `paused` and `queued` call `this.dedupe.cancelSubscriber(sessionId)` and **discard the result**. If the cancelled session is a dedupe *primary* with live subscribers, the registry promotes a subscriber (`promotedTo`) — but the scheduler never transfers the pending queue slot / paused worker / gate admission, never flips the promoted record out of `isSubscriber`. The promoted subscriber and all remaining subscribers hang forever. The general path (lines ~436–482) already contains the correct promotion transfer logic; the early branches bypass it.

Fix: restructure `cancelSession` so `dedupe.cancelSubscriber` is called once, up front, and the promotion-transfer block runs for all states. The existing transfer code already handles `worker`, `pausedOnWorker`, and `pending` cases — the queued/paused early returns just need to happen *after* (or be merged into) that logic. Take care to keep the S1 discard-set registration in the paused branch. Regression tests: (a) cancel a queued primary with one subscriber → subscriber inherits the queue slot and eventually decodes; (b) cancel a paused primary with one subscriber → subscriber inherits the parked decoder.

### S5 (P1) — Acquisition-path leaks: dedupe registration, admission, abort window

Three related holes in `acquireSlot`:
1. After `this.dedupe.register(sessionId, sourceKey)`, every failure exit (`destroyed` throws after the admission await, after `pool.acquire`, after `tryPreempt`) leaves the registration live. Future requests for the same sourceKey subscribe to a dead phantom primary and never receive a message.
2. `cancelSession` called while the caller is awaiting `admissionGate.admit(...)` finds no session record (it is created later), so the cancel is a no-op — when admission resolves, the scheduler assigns a worker to an already-cancelled session (ghost decode burns a worker until its consumer notices).
3. An `AbortSignal` aborted during the admission/spawn awaits is only observed *after* assignment (via `setupSignalAbort`'s `signal.aborted` fast path) — for the queued path that is fine, but the assigned-path ghost still ran `assignWorker` + `worker.handle.send(startMsg)` first.

Fix — single guard helper called after every `await` in `acquireSlot`:

```ts
private abortAcquisition(params: { sessionId: string; sourceKey: string | null }, reason: string): never {
  this.releaseAdmission(params.sessionId);
  if (params.sourceKey !== null) this.dedupe.complete(params.sessionId); // removes key→primary mapping
  throw new Error(reason);
}

// after admission await, after pool.acquire, after tryPreempt:
if (this.destroyed) this.abortAcquisition(params, "[jxl-scheduler] Scheduler is shut down.");
if (params.signal?.aborted === true) this.abortAcquisition(params, "[jxl-scheduler] Session aborted before assignment.");
```

Caveat: `dedupe.complete` on a primary that already accumulated subscribers must notify those subscribers (synthesize `decode_cancelled` to their handlers) — check `sessions` for subscriber records of this id and fan out before deleting. Keep the queued-path rejection (`cancelSession` queued branch) calling the same cleanup.

### S6 (P1) — Abort-listener double registration

`setupSignalAbort` is called when a session is queued (line ~349) **and again** when `drainQueue` assigns it (both sync and async loops). The second call registers a second `abort` listener and overwrites `rec.abortCleanup`, so the first listener is never removed. With a long-lived signal (page-lifetime AbortController over a gallery session), listeners accumulate — exactly the leak `abortCleanup` was added to prevent. Double `cancelSession` on abort is harmless but wasteful.

Fix — make it idempotent:

```ts
private setupSignalAbort(sessionId: string, signal: AbortSignal | null): void {
  if (signal === null) return;
  const rec = this.sessions.get(sessionId);
  if (rec?.abortCleanup !== undefined) return; // already wired while queued
  ...
}
```

(Or remove the redundant calls in `drainQueue`; the guard is safer against future call sites.)

### S7 (P1) — Backpressure waiters stranded on terminal cleanup

`unblockBackpressure` is invoked from `cancelSession` and `shutdown`, but **not** from `cleanupSession`. A producer blocked in `waitForDrain` when the session ends via `decode_error` / `decode_budget_exceeded` / `decode_final` (terminal arrives between push and drain) awaits forever. Fix:

```ts
private cleanupSession(sessionId: string): void {
  this.releaseAdmission(sessionId);
  const record = this.sessions.get(sessionId);
  if (record !== undefined) {
    this.adjustSessionCount(record, -1);
    record.abortCleanup?.();
    this.unblockBackpressure(record);
  }
  ...
}
```

### S8 (P2) — Stale priority in `assignWorker`

`assignWorker` derives `priority` from `startMsg.priority`. Dedupe escalation (visible subscriber on background primary) mutates `record.priority` and `pending.priority` but not the start message — so on queued→running the worker is put back into `backgroundWorkers` despite the record being visible. `findBackgroundWorker`'s `hasVisible` re-check masks the preemption hazard, but `metrics.background` is wrong and the masking is fragile. Fix:

```ts
const existing = this.sessions.get(sessionId);
const priority = existing?.priority ?? startMsg.priority;
```

(move the `existing` lookup above the priority computation). Optionally also overwrite `startMsg.priority`-derived `kind` consistently — kind cannot change, priority can.

### S9 (P2) — `resumePausedSession` on a terminated worker

If the worker hosting a parked decoder crashed/was recycled while its active session ran, the terminal path still calls `resumePausedSession(worker, pausedId)` → `pool.bind` throws on `terminated` — and the throw escapes inside the worker `onMessage` callback. Guard before bind:

```ts
if (worker.handle.terminated || record === undefined || record.state !== "paused") {
  if (record !== undefined && record.state === "paused") {
    for (const h of record.handlers) { try { h({ type: "decode_cancelled", sessionId } as WorkerToMainMessage); } catch {} }
    this.cleanupSession(sessionId);
  } else if (!worker.handle.terminated) {
    this.pool.release(worker);
  }
  this.drainQueue();
  return;
}
```

### S10 (P2) — Victim scoring is kind-blind

`scoreVictim` = `progress*3 + ageNorm*1`. Encode sessions report `progress === 0` forever (no protocol progress), so encoders are systematically the *preferred* victims — yet encode victims are **cancelled** (all work destroyed, including any butteraugli-priced effort already spent in libjxl), while decode victims are **paused** (work preserved, resumable). The cost model is inverted. Add a kind penalty:

```ts
private readonly PREEMPT_ENCODE_W = 1.5; // cancelled encodes lose all work; paused decodes lose none

private scoreVictim(record: SessionRecord): number {
  const ageNorm = Math.min(1, (performance.now() - record.createdAt) / this.PREEMPT_AGE_NORM_MS);
  return record.progress * this.PREEMPT_PROGRESS_W
    + ageNorm * this.PREEMPT_AGE_W
    + (record.kind === "encode" ? this.PREEMPT_ENCODE_W : 0);
}
```

This is a cost-model correction, not an adaptive heuristic, but still validate against `scheduler.preemption` tests and note the constant is tunable.

### S11 (P2) — Header doc contradicts budget contract

File header (line ~15): "budgetMs enforced per-stage transition, not wall-clock across whole decode." CLAUDE.md states the opposite and forbids per-stage resets ("Budget is session-level elapsed time from construction… Do not add per-stage resets", rejection DH-5/DH6-5). The comment is stale and is exactly the kind of text that re-seeds the rejected proposal. Fix the comment to: "budgetMs is session-level elapsed time from session construction; never per-stage."

### S12 (P2, benchmark-gated) — Drain EMA cannot recover

`updateDrainEma` runs only when a waiter existed, so after one slow-drain episode the EMA (and thus `adaptiveHwm`) stays depressed until the *next* blocking event — which the depressed HWM makes more likely (hysteresis trap). Candidate fix: decay toward the neutral 50 ms on unblocked drains in `signalDrain`:

```ts
} else {
  // No waiter: drains are keeping up; decay EMA toward neutral so HWM recovers.
  this.drainLatencyEma += (50 - this.drainLatencyEma) * 0.05;
}
```

Per CLAUDE.md, adaptive/heuristic changes require benchmark data: run `benchmark/` lightbox scenarios C/D (qwait column) before/after; if no measurable win, reject with reasoning rather than land untested tuning. Also fix the stale comment "up to 16" above `adaptiveHwm` (cap is `pushHwm*2 = 8` at default).

### S13 (P2, investigate) — worker_drain coalescing vs. one-resolve-per-drain

`signalDrain` resolves exactly one waiter per `worker_drain` message. CLAUDE.md's decode-handler test gaps mention "worker_drain coalesced". If the worker coalesces N pushes into one drain message, `queueDepth` ratchets upward and waiters starve. Read `packages/jxl-worker-browser/src/decode-handler.ts` (reference only) to confirm the contract: one drain per push, or drains carry no count. If coalescing is real, fix scheduler-side: resolve waiters while `bp.queueDepth < this.adaptiveHwm()` and decrement depth per resolve (or request a `count` field on the protocol message at the end, as an out-of-ambit change request). Do not change the protocol unilaterally.

### S14 (P3, feature) — `setPriority(sessionId, priority)`

Priority is fixed at `acquireSlot` except for dedupe escalation. The gallery/AR use case (memory: pyramid viewer, viewport scrolling) wants to promote `near` prefetches to `visible` and demote scrolled-away tiles to `background` without cancel/restart. All machinery exists (queue remove+enqueue, `backgroundWorkers` set):

```ts
setPriority(sessionId: string, priority: Priority): boolean {
  const record = this.sessions.get(sessionId);
  if (record === undefined) return false;
  if (record.priority === priority) return true;
  record.priority = priority;
  if (record.state === "queued" && record.pending !== undefined) {
    this.queue.remove(sessionId);
    record.pending.priority = priority;
    this.queue.enqueue({ priority, sessionId, payload: record.pending });
  } else if (record.worker !== undefined) {
    if (priority === "background") this.backgroundWorkers.add(record.worker);
    else this.backgroundWorkers.delete(record.worker);
  }
  return true;
}
```

Note: requeue places the session at the back of the new lane (same semantics as the existing dedupe escalation). Document that. This is a headline-feature candidate (real-time priority steering for the biodiversity lightbox).

### S15 (P3, feature) — Bound parked decoder memory

The `workerPausedSession` comment already names the feature: "evict/cancel oldest parked when parked count exceeds a threshold". Each parked session pins a full WASM decoder heap. Add `maxParkedSessions?: number` to `SchedulerOptions` (default `Infinity` to preserve behavior); after parking in `tryPreempt`, if `workerPausedSession.size > max`, pick the paused record with the smallest `createdAt` and cancel it via the existing paused-cancel path (which, after S1, is safe). Test: three preemptions with `maxParkedSessions: 1` → oldest two receive `decode_cancelled`.

### S16 (P3) — Dispatch micro-allocs + pool gauges

(a) Subscriber fan-out of a metric message spreads twice (`stampedMsg` + `protectMetricForDispatch` clone). Fuse: give `protectMetricForDispatch` an optional `stampSessionId` parameter performing one spread for non-metric and one combined spread+freeze for metric messages. (b) `getMetrics()` lacks pool visibility; add `poolSize`, `poolIdle`, `poolParked`, `poolSpawning` read from public pool getters (additive fields on `SchedulerMetrics`). Both are small; skip (a) if the diff hurts readability.

---

## Agent 2 — pool.ts

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article.

File: `packages/jxl-scheduler/src/pool.ts`.

### P1 (P1) — Spawn timeout leaks the late worker

`createWorkerWithTimeout` races `this.factory()` against a timeout. On timeout the race rejects, but the factory promise is abandoned — when it later resolves, the freshly booted Web Worker (with its WASM heap and possible pthread pool) is never shut down. Repeated slow spawns (cold cache, throttled tab) leak real OS threads. Fix:

```ts
private async createWorkerWithTimeout(): Promise<WorkerHandle> {
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  let timedOut = false;
  const factoryPromise = this.factory();
  // Late arrival after timeout: shut the orphan down instead of leaking it.
  factoryPromise.then(
    (h) => { if (timedOut) void h.shutdown(RECYCLE_SHUTDOWN_TIMEOUT_MS).catch(() => undefined); },
    () => undefined, // factory rejection after timeout: nothing to clean
  );
  try {
    return await Promise.race([
      factoryPromise,
      new Promise<never>((_, reject) => {
        timeout = globalThis.setTimeout(() => {
          timedOut = true;
          reject(new Error(`[jxl-scheduler] Worker spawn timed out after ${this.spawnTimeoutMs}ms`));
        }, this.spawnTimeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) globalThis.clearTimeout(timeout);
  }
}
```

Also confirm the CoreBudget tokens taken in `spawn()` for the timed-out attempt are released — they are (the `catch` in `spawn()` releases on throw), but add a test asserting `budget.available` returns to capacity after a timeout.

### P2 (P3) — `parked ∩ idle` defensive branches

`takeIdleWorker` and `reapIdle` both begin with `if (this.parked.has(worker)) { this.parked.delete(worker); continue; }` while iterating `this.idle`. `assertInvariants` declares parked∧idle impossible, and `park()` removes from idle. Either (a) there is a real path producing the overlap (find it — that would be a bug), or (b) this is dead code masking future state-machine holes. Trace all `parked.add` / `idle.add` sites; if no overlap path exists, replace both branches with a DEV-only assertion throw so violations surface instead of being silently "repaired".

### P3 (P3) — DEV detection inert in browsers

`DEV` is `false` whenever `typeof process === "undefined"`, so `assertInvariants` never runs in a plain browser dev session (it works under bundlers that define `process.env.NODE_ENV`). Cheap widening: `const DEV = (typeof process !== "undefined" && process.env["NODE_ENV"] !== "production") || (typeof process === "undefined" && typeof (globalThis as any).__JXL_DEV__ !== "undefined");` — or simply document the bundler assumption in the comment. Do not enable invariants unconditionally in production (O(n) per acquire/release).

### Notes — verified non-issues (do not "fix")

- `takeIdleWorker` deleting from `this.idle` mid-iteration is safe (JS Set semantics).
- `spawnInner`'s add-to-idle followed by synchronous `reserve` has no interleaving window (single-threaded).
- Budget release on destroyed-during-spawn path is correct (`workers.has` check in `spawn()`).
- `release()` setting `cancelling=false` is intentional (worker survives a cancel and returns to idle).

---

## Agent 3 — queue.ts

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article.

File: `packages/jxl-scheduler/src/queue.ts`. The head-index + `copyWithin` compaction at threshold 64 is settled design (rejection DH-4 covers lowering it) — leave thresholds alone.

### Q1 (P3) — Lane hint for `remove()`

`remove(sessionId)` linearly scans visible, then near, then background. Every caller in scheduler.ts knows the record's priority. Add an optional hint, falling back to a full scan because dedupe escalation can leave a stale priority on the caller's side:

```ts
remove(sessionId: string, priority?: Priority): boolean {
  if (priority !== undefined) {
    const head = priority === "visible" ? this._visibleHead
      : priority === "near" ? this._nearHead : this._backgroundHead;
    if (this.swapDelete(this.lane(priority), head, sessionId)) { this._size--; return true; }
    // Hint may be stale (priority escalated after enqueue) — fall through to full scan.
  }
  if (this.swapDelete(this.visible, this._visibleHead, sessionId)) { this._size--; return true; }
  if (this.swapDelete(this.near, this._nearHead, sessionId)) { this._size--; return true; }
  if (this.swapDelete(this.background, this._backgroundHead, sessionId)) { this._size--; return true; }
  return false;
}
```

Updating scheduler.ts call sites to pass the hint is an out-of-ambit change — request it at the end (the no-arg form stays correct meanwhile).

### Q2 (P3) — Per-lane sizes; audit dead exports

(a) Add an observability getter (used by Agent 1's pool-gauge work and by prefetch tuning):

```ts
get laneSizes(): { visible: number; near: number; background: number } {
  return {
    visible: this.visible.length - this._visibleHead,
    near: this.near.length - this._nearHead,
    background: this.background.length - this._backgroundHead,
  };
}
```

(b) `peek()` and `backgroundIds()` have no callers in scheduler.ts. Grep the repo (including tests and jxl-session); if genuinely unused, delete them — if test-only, mark `/** @internal test support */`.

(c) Optional: the triplicated dequeue lane logic could collapse into a helper operating on a `{ arr, head }` lane struct. Only do this if it does not regress the monomorphic shape of the three hot branches (measure or skip — readability-only refactor, low value).

---

## Agent 4 — budget.ts

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article.

File: `packages/jxl-scheduler/src/budget.ts`.

### B1 (P2) — Unsatisfiable acquire hangs forever

`acquire(cost)` with `cost > capacity` enqueues a waiter that can never be satisfied (`release` caps tokens at `capacity`), and FIFO `drainWaiters` then **blocks every later waiter behind it** — a single MT pool with `workerCost = hardwareConcurrency + k` (possible if a caller miscomputes cost, e.g. counts logical cores differently than the budget's capacity source) deadlocks all pools sharing `globalCoreBudget`. Guard:

```ts
async acquire(cost = 1): Promise<void> {
  if (cost <= 0) return;
  if (cost > this.capacity) {
    throw new Error(`[jxl-scheduler] CoreBudget: cost ${cost} exceeds capacity ${this.capacity}`);
  }
  ...
}
```

`acquireWithFallback(mtCost > capacity)` currently falls back to cost 1 silently — that behavior is correct and must keep working; route its internal MT check so it never calls `acquire(mtCost)` with an over-capacity cost (it already doesn't — verify with a test: `acquireWithFallback(capacity + 1)` resolves with 1).

### B2 (P3) — Introspection + over-release detection

(a) Add `get pendingCount(): number { return this.waiters.length; }` — feeds scheduler metrics and the existing benchmark harness without touching internals. (b) `release()` clamping to capacity silently masks double-release bugs (the exact class of bug Agent 2's P1 test looks for). Emit a DEV-only warning:

```ts
release(cost = 1): void {
  if (cost <= 0) return;
  const next = this.tokens + cost;
  if (next > this.capacity && typeof process !== "undefined" && process.env["NODE_ENV"] !== "production") {
    console.warn(`[jxl-scheduler] CoreBudget over-release: ${this.tokens}+${cost} > ${this.capacity}`);
  }
  this.tokens = Math.min(this.capacity, next);
  this.drainWaiters();
}
```

(c) Leave the FIFO head-of-line semantics alone — it is the documented anti-starvation design for MT acquisitions; `acquireWithFallback` exists precisely so callers avoid queuing high costs.

---

## Agent 5 — dedupe.ts

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article.

File: `packages/jxl-scheduler/src/dedupe.ts`.

### D1 (P2) — `complete()` on a subscriber id leaves dangling registry state

`Scheduler.cleanupSession` calls `dedupe.complete(sessionId)` for *every* session, including fan-out subscribers. For a subscriber id, `complete()` finds no `sessionToKey` / `sessionToSubscribers` entries and returns — leaving `subscriberToPrimary[sub]` dangling and the sub still inside the primary's subscriber set. Until the primary completes, message fan-out keeps iterating the dead sub (hits `EMPTY_HANDLERS`, wasted work) and `subscribers()` over-reports. Make `complete()` subscriber-aware:

```ts
complete(sessionId: string): void {
  const primary = this.subscriberToPrimary.get(sessionId);
  if (primary !== undefined) {
    // Subscriber completing independently of its primary: detach only.
    this.subscriberToPrimary.delete(sessionId);
    this.sessionToSubscribers.get(primary)?.delete(sessionId);
    return;
  }
  ... existing primary cleanup ...
}
```

Note this must NOT trigger primary cancellation when the set empties — completion is not cancellation; the primary finishes on its own. (If you want last-subscriber-gone-while-primary-running to cancel the worker, that is `cancelSubscriber`'s job and already works.)

### D2 (P3) — Promotion choice is arbitrary

`cancelSubscriber` promotes `subs.values().next().value` — insertion order, priority-blind. A visible subscriber can end up subordinate to a promoted background one; the scheduler currently papers over the preemption consequence with its `hasVisible` re-scan. Let the caller choose:

```ts
cancelSubscriber(
  subscriberId: string,
  pickPromoted?: (candidates: ReadonlySet<string>) => string | undefined,
): { cancelWorker: boolean; promotedTo?: string } {
  ...
  if (isPrimary) {
    const newPrimaryId = pickPromoted?.(subs) ?? subs.values().next().value;
    ...
```

Out-of-ambit follow-up (request at the end): scheduler.ts passes a selector preferring `visible` > `near` > `background` using its `sessions` map. Backwards compatible — omitting the callback preserves today's behavior.

### D3 (doc) — Self-membership

`register()` seeds the subscriber set with the primary itself, so `subscribers(primary)` includes the primary and `forEachSubscriber` callers must skip `subId === primaryId` (scheduler does). Document this on both methods — it has bitten the fan-out path's readability twice (the skip looks redundant without the context).

---

## Agent 6 — types.ts

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You may reference files outside your ambit if necessary, but if you want to change them, request to do so at the end of everything else. If there are any unusually important novel features or highlights, add them to the file c:\Foo\raw-converter-wasm\docs\Headline Features.md providing two or three paragraphs about it as if it were a news article.

File: `packages/jxl-scheduler/src/types.ts`.

### T1 (P3) — Dead `Session` interface

`Session` (with `pendingResolve`/`pendingReject`/`subscribers`) describes a design the scheduler replaced with its private `SessionRecord`. Grep the whole repo for `import … Session` from this module (and the package's public exports/barrel) — if unused outside this file, delete it; if exported through the package index and consumed by tests or jxl-session typings, deprecate with a pointer to the scheduler's actual surface instead.

### T2 (P3) — `WorkerHandle` crash-event members

`pool.ts#wireWorker` already probes `onError`/`onExit` via a structural cast ("WorkerHandle does not expose these today"). Promote them into the interface as optional, so spawn implementations get a typed contract to implement crash recovery against:

```ts
export interface WorkerHandle {
  send(msg: MainToWorkerMessage, transfer?: ArrayBuffer[]): void;
  onMessage(handler: (msg: WorkerToMainMessage) => void): void;
  shutdown(timeoutMs?: number): Promise<void>;
  readonly terminated: boolean;
  /** Optional: fired on worker-level error; pool recycles the worker. */
  onError?(handler: (err: unknown) => void): void;
  /** Optional: fired on unexpected worker exit; pool recycles the worker. */
  onExit?(handler: () => void): void;
}
```

Out-of-ambit follow-up (request at the end, do not implement without approval): wire these in `packages/jxl-worker-browser/src/spawn.ts` and `packages/jxl-worker-node/src/spawn.ts` (`worker.onerror` / `worker.on("exit")`) — that turns the pool's currently-inert crash recovery into a live feature, and combined with Agent 1's S9 guard closes the "worker dies mid-decode" gap end to end. This is a headline-feature candidate (self-healing worker pool).

### T3 (doc) — `AdmissionGate` cancellation contract

`admit()` has no abort parameter; the scheduler can be cancelled while a caller is parked inside it (Agent 1's S5 handles the post-resolve check). Document on the interface: "admit() may resolve after the session was cancelled or the scheduler destroyed; the scheduler releases the returned token immediately in that case. Implementations should resolve promptly and must tolerate the release being the first and only interaction." Adding an `AbortSignal` parameter is a breaking change to gate implementors — note it as a possible future extension only.

---

## Unexplored rooms (Lens 21)

1. **Worker crash recovery** is scaffolding-only: `wireWorker` probes events no handle provides, and `resumePausedSession`/terminal handling assume workers never die mid-flight. T2 + S9 together light this room.
2. **The encode arm of preemption** has, by the evidence of S3 (a path that throws on every execution), never run under test. Encode preemption, encode victim scoring (S10), and encode-session metrics are systematically less exercised than decode.
3. **Cross-scheduler dynamics through `globalCoreBudget`**: multiple contexts sharing one token pool with MT/ST mixed costs (FIFO HOL semantics, fallback paths) have no integration tests; B1's deadlock guard is the minimum safety net.

## Overview — what implementing this buys

The three P0s close real correctness holes in the scheduler's most delicate mechanism: the shared-worker pause/park protocol. Today, cancelling a paused background session can tear down the visible decode that displaced it (S1); a victim finishing naturally at the wrong moment gets a healthy — possibly reassigned — worker terminated under it (S2); and preempting an encode session throws an exception into the visible caller's acquisition path every single time (S3). All three are silent in light testing because they need specific interleavings (a parked decoder sharing a worker, a terminal racing a pause, an encode running at background priority), but a biodiversity gallery doing aggressive scroll-driven prefetch — many background decodes, frequent preemption, periodic sidecar encodes — is precisely the workload that produces those interleavings constantly. With the P1 batch (promotion transfer in all cancel branches, acquisition-path cleanup, abort-listener idempotence, backpressure unblocking), the scheduler stops leaking registrations, listeners, and stranded promises across the long-lived, signal-heavy sessions the pyramid viewer creates.

The P2 tier hardens the economic logic rather than the plumbing. Victim scoring that knows pausing a decode is nearly free while cancelling an encode burns all invested effort (S10) means preemption starts minimizing real work lost — directly relevant to keeping expensive, butteraugli-priced encode effort from being thrown away. The CoreBudget guard (B1) removes a one-line path to a whole-application worker deadlock shared across every scheduler in the page. The dedupe fixes (D1, D2) keep the registry exact under early-completing subscribers and make promotion respect visibility, removing the need for the scheduler's compensating re-scans to mask registry arbitrariness.

The feature items are small in code but large in product leverage. `setPriority` (S14) turns the three-lane queue from an admission-time decision into a live steering surface: the lightbox can promote tiles entering the viewport and demote tiles leaving it without destroying decoder state — the scheduling primitive that real-time AR identification and smooth gallery scroll both reduce to. `maxParkedSessions` (S15) converts an acknowledged unbounded-memory TODO into a bounded guarantee. The typed `onError`/`onExit` contract (T2) plus the resume guard (S9) upgrade the pool from "assumes workers are immortal" to genuinely self-healing, which matters for field/offline use on low-memory mobile devices where the OS reaps workers without asking.

Net effect: the scheduler's published invariants — preemption is safe, dedupe never strands a subscriber, backpressure never wedges a producer, the pool never exceeds its core budget — become actually true under adversarial interleavings, not just on the happy path, while the observability additions (queue lane sizes, pool gauges, budget pending count) make the next benchmark-driven tuning round measurable instead of speculative.
