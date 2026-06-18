# jxl-scheduler Improvement Progress

Branch: `jxl-scheduler-20260618`

| File | Strategic | Operational | Tactical | Birds-Eye | Committed |
|------|-----------|-------------|----------|-----------|-----------|
| types.ts | ✓ | — | ✓ | ✓ | ✓ |
| budget.ts | ✓ | ✓ | ✓ | ✓ | ✓ |
| queue.ts | ✓ | ✓ | ✓ | ✓ | ✓ |
| dedupe.ts | ✓ | ✓ | ✓ | ✓ | ✓ |
| pool.ts | ✓ | ✓ | ✓ | ✓ | ✓ |
| scheduler.ts | ✓ | ✓ | ✓ | ✓ | ✓ |
| index.ts | ✓ | — | ✓ | ✓ | ✓ |

## Findings Log

### types.ts (2026-06-18)
- [S1] `AdmissionGate.admit` returned anonymous `() => void` — added `AdmissionRelease` type alias
- [T1] `pool.ts::wireWorker` had redundant cast + stale comment claiming `onError/onExit` missing from `WorkerHandle` (they're in the interface); removed
- One sweep sufficient (48 lines, pure types, no runtime code)

### budget.ts (2026-06-18)
- [O1] `_isProduction()` static method called on every `release()` — hot path re-evaluates env globals each call; cached as `_devMode` in constructor
- [T1] `tryAcquire(cost > capacity)` returns false vs `acquire()` throws — asymmetry now documented in JSDoc

### queue.ts (2026-06-18)
- [O1] 3× identical 6-line compact-after-dequeue blocks in `dequeue()` (visible/near/background lanes)
- [T1] Extracted `static compactLane<U>()` helper + `popLane()` — dequeue body 42→14 lines, single source of truth

### dedupe.ts (2026-06-18)
- [T1] `forEachSubscriber` iterated live Set — if `fn` called `cancelSubscriber`, the deleted-but-unvisited subscriber was silently skipped (JS Set spec)
- Fixed: snapshot via `[...subs]` before iteration; updated comment from "zero-allocation" to "bounded-allocation"

### pool.ts (2026-06-18)
- [T1] `reapIdle`: dead `parked.has(worker)` branch — `park()` removes from idle first, so this branch is unreachable but if triggered would silently remove from parked without budget release/shutdown hooks
- [T2] `takeIdleWorker`: same dead branch; removed
- [T3] `wireWorker`: stale cast (covered by types.ts fix above)

### scheduler.ts (2026-06-18)
- **[P0-1]** `cancelSession` paused branch: missing `unblockBackpressure(record)` — callers blocked in `waitForDrain` on a paused session hang forever (no `worker_drain` can arrive from a dormant worker)
- **[P0-2]** `shutdown()`: `unblockBackpressure` only called for queued sessions; running + paused sessions' pending `waitForDrain` promises also hang
- [P1] `drainQueue` sync error path: on `assignWorker` throw, loop returned immediately — remaining queued sessions waited for next unrelated worker completion; now falls through to continue drain
- Added 2 regression tests: `scheduler.backpressure.test.ts` (42/42 pass)
