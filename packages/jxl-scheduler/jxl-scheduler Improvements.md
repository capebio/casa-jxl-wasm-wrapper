# jxl-scheduler Improvements

**Date:** 2026-06-18  
**Branch:** `jxl-scheduler-20260618`  
**Commits:** 7  
**Tests:** 42 pass / 0 fail (↑2 new regression tests)

---

## Summary of improvements

A systematic three-level review (Strategic → Operational → Tactical) of all 7 source files in `packages/jxl-scheduler/src/`, followed by a birds-eye consolidation pass per file.

### types.ts

Added `AdmissionRelease = () => void` named type alias and used it as the return type of `AdmissionGate.admit()`. Previously the release function was anonymous `() => void`, making call-site types harder to read and impossible to reference elsewhere. Exported from `index.ts`.

Removed the redundant cast in `pool.ts::wireWorker` that re-declared `onError`/`onExit` as if they weren't already in `WorkerHandle`. The stale comment saying "WorkerHandle does not expose these today" was incorrect — both hooks have been in the interface for some time.

### budget.ts

`CoreBudget.release()` is called on every worker completion (hot path). The `_isProduction()` static method re-evaluates `process.env.NODE_ENV` and `globalThis.__DEV__` on every call. Cached the result at construction time as `_devMode: boolean`. No behaviour change; the dev warning fires on the same conditions.

Added JSDoc to `tryAcquire()` documenting the API asymmetry: `cost > capacity` returns `false` (non-throwing) where `acquire()` throws. Callers relying on the silent-false return would have been surprised when they switched to the async path.

### queue.ts

The `dequeue()` method had three identical 6-line compact-after-dequeue blocks — one per priority lane (visible / near / background). Any future change to the compaction threshold or strategy required editing all three. Extracted:

- `popLane(lane, head)` — reads the front entry without advancing
- `static compactLane<U>(lane, head)` — amortised clear/copyWithin, returns new head index

`dequeue()` body shrank from 42 to 14 lines. Logic is identical; all queue tests pass.

### dedupe.ts

`forEachSubscriber` iterated over the live `sessionToSubscribers` Set. If the callback `fn` called `cancelSubscriber` (possible when a subscriber's message handler synchronously triggers a cancel), the JavaScript Set iterator silently skips any unvisited-but-deleted entries per the Set spec. In a fan-out dispatch scenario with N subscribers, a cancel triggered by subscriber[0]'s handler would cause subscriber[1..N-1] to miss the message.

Fixed by snapshotting via `[...subs]` before iteration. The allocation cost is one array of N IDs (typically 0–3 entries). Updated the "zero-allocation" comment to "bounded-allocation" with a clear explanation.

### pool.ts

`reapIdle()` and `takeIdleWorker()` both had a dead `this.parked.has(worker)` branch. The `park()` method calls `this.idle.delete(worker)` before `this.parked.add(worker)`, so a worker in `parked` can never simultaneously be in `idle`. The branch was unreachable — but if somehow triggered by an invariant violation it would silently `parked.delete(worker)` without calling `cleanupAndRemove()`, leaking the worker's coreBudget tokens and skipping the shutdown hook. Removed both dead branches. The `assertInvariants()` DEV check already detects workers in multiple sets.

### scheduler.ts — P0 fixes

**Bug 1 (waitForDrain hang on paused-session cancel):** `cancelSession` for paused sessions called `sessions.delete(sessionId)` without first calling `unblockBackpressure(record)`. Any caller blocked in `waitForDrain` (push chunk, awaiting drain) on a paused session would hang indefinitely — no `worker_drain` message can arrive from a dormant worker, so `signalDrain` never fires.

Fix: added `this.unblockBackpressure(record)` before `sessions.delete(sessionId)` in the paused branch of `cancelSession`.

**Bug 2 (waitForDrain hang on shutdown):** `shutdown()` iterated all sessions and called `unblockBackpressure` only for queued sessions. Running and paused sessions' pending `waitForDrain` promises remained unresolved after `pool.shutdown()` terminated their workers. Callers blocked on these promises would hang until the GC eventually collected the session record (which never resolves the promise).

Fix: added `this.unblockBackpressure(record)` in the running/cancelling and paused branches of the shutdown session loop.

**Improvement (drain continues after head error):** `drainQueue()` sync path: when `assignWorker` threw for the queue head, the loop called `drainingQueue = false; return`, leaving remaining queued sessions waiting for the next unrelated worker completion. Changed to fall through to the next iteration so the drain continues with the next idle worker.

**Regression tests:** Added `test/scheduler.backpressure.test.ts` with two tests that directly exercise the fixed paths.

---

## ##Benchmark

StandardMultifileTest.mjs — `2026-06-18T00:03:47Z` — **exit 0, no regressions**.

| Metric | Value |
|--------|-------|
| AvgRawMs | 923ms |
| AvgProgEncSimdMs | 407ms |
| AvgShotDecSimdMs | 262ms |
| MultiWorkerSequentialDecSumMs | 2094ms |
| MultiWorkerParallelWallMs | 412ms |
| **MultiWorkerSpeedupRatio** | **5.08×** |
| MT first-frame speedup | 4.2× |
| MT shot decode speedup | 4.0× |
| JXTC vs one-shot ratio | 0.75× |

The scheduler changes (correctness fixes and cleanups) produced no measurable change in encode/decode timing — as expected, since the changes only affect control-plane paths (backpressure resolution, dead code removal, Set iteration). The 5.08× parallel speedup and 4.0–4.2× MT decode gains remain intact.

## ##Key findings

1. **Two P0 hang bugs** in `scheduler.ts`: `cancelSession` (paused) and `shutdown()` both omitted `unblockBackpressure` for non-queued sessions, causing permanent hangs in `waitForDrain` callers. These paths are exercised under preemption (paused sessions are created by visible preempting background) and during normal shutdown of active schedulers.

2. **Dead code with bad-path risk** in `pool.ts`: The `parked.has(worker)` checks in `reapIdle` and `takeIdleWorker` were never reachable because `park()` removes from idle before adding to parked. If somehow reached they would leak the worker's budget tokens.

3. **Set mutation during iteration** in `dedupe.ts`: `forEachSubscriber` called external handlers over a live Set; a reentrant cancel would silently skip unvisited subscribers. Fixed by snapshotting.

4. **Hot-path overhead** in `budget.ts`: `release()` re-evaluated `process.env.NODE_ENV` on every call. Cached.

5. **Code duplication** in `queue.ts`: Three-lane dequeue had identical compact logic; now a single static helper.

## ##Conclusion

All 7 source files reviewed. Two P0 bugs corrected with regression tests. Four lower-severity cleanups applied (dead code removal, hot-path caching, triplication refactor, safe iteration). Total: 42 tests pass, 0 fail. The scheduler's core invariants (FIFO budget, preemption, dedupe promotion, adaptive backpressure) are preserved unchanged.

## ##Achievements

- P0 backpressure hang eliminated for paused-session cancel path
- P0 backpressure hang eliminated for scheduler shutdown path
- Regression test suite expanded: 40 → 42 tests
- `queue.ts` dequeue maintenance burden eliminated (3× → 1× compact logic)
- `dedupe.ts` forEachSubscriber now correct under reentrant handler cancellation
- `pool.ts` dead branches removed; risk of silent budget token leak eliminated
- `budget.ts` hot-path overhead reduced (env check cached at construction)
- `types.ts` AdmissionRelease type alias improves API readability

## ##Opportunities

**Birds-eye view of the full scheduler package:**

The five files (`budget`, `queue`, `dedupe`, `pool`, `scheduler`) form a tight, layered system with clear responsibilities. The dominant architectural risk is **bypass paths around `cleanupSession()`**: every direct `sessions.delete(sessionId)` outside of `cleanupSession` must manually call `releaseAdmission`, `adjustSessionCount`, `unblockBackpressure`, `abortCleanup`, and `dedupe.complete`. This review found two places that missed `unblockBackpressure`. Future work should consider whether `cleanupSession` can be made the only deletion path, or whether a lint rule can flag direct `sessions.delete` calls.

**Observable session lifecycle:** The scheduler currently has no hook for external observers to watch session state transitions (queued → running → paused → cancelled). A `onSessionStateChange` callback (or an EventTarget) would allow tooling, dashboards, and test harnesses to verify lifecycle correctness without white-box access to internals. This would also make the regression tests less reliant on timing (`setTimeout(res, 10)` polls).

**Backpressure EMA cold start:** `drainLatencyEma` initialises at 50ms so the HWM starts neutral. Under burst load on a fresh scheduler, the EMA converges slowly (α=0.2). A faster warm-up (e.g., α=0.5 for the first 5 samples) would make the adaptive HWM responsive to actual system behaviour sooner.

**Parked-session memory bound:** `maxParkedSessions` exists (S15) but the eviction policy is "cancel oldest". If a newly-parked session is larger than the oldest (e.g., a 4K frame vs a thumbnail), a size-aware eviction policy would be more memory-efficient. This requires the scheduler to know the approximate pixel footprint of each session — available from the `MsgDecodeStart.targetWidth/targetHeight` fields.

**DedupeRegistry fan-out scalability:** `forEachSubscriber` now allocates a snapshot array per call. For the common case (0 subscribers) this is a no-op. For 1–2 subscribers it's a 1–2 element array. If a single primary ever accumulates many subscribers (e.g., a gallery tile viewed from 10 consumers simultaneously), a more allocation-efficient approach would be a copy-on-write subscriber list. Not needed at current scale.
