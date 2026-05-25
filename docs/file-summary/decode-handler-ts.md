# Working Notes: packages/jxl-worker-browser/src/decode-handler.ts
> Worker-side decode session — feeds WASM, drains events, manages budget/backpressure/pause
> Feature covered: #2 (Advanced Scheduling & Flow Control)

---

## Index of Key API

| Symbol | Kind | Purpose |
|--------|------|---------|
| `DecodeHandler` | class | Owns one libjxl decoder per session; runs `feedDecoder + readDecoderEvents` in parallel |
| `onChunk(chunk)` | method | Enqueues chunk; enforces MAX_QUEUED_BYTES hard cap |
| `onClose()` | method | Signals end-of-input; closes decoder after feed loop drains |
| `onCancel(reason)` | async method | Terminal cancel; idempotent; disposes decoder |
| `onPause()` | method | Sets paused flag, wakes feedDecoder, posts `decode_paused` immediately |
| `onResume()` | method | Clears paused flag, wakes resume waiter |
| `maybePostDrain()` | private | Coalesced drain signal: crossedIntoDrain OR intervalElapsed (8ms) |
| `checkBudget()` | private | Session-elapsed vs budgetMs; called pre-transfer on progress events |
| `postBudgetExceeded()` | private | Graceful finish — `finishSession("budget_exceeded")`, not `failSession` |
| `disposeActiveDecoder()` | private | Shared disposal promise — multiple callers join same op |

---

## Feature #2 Coverage

| Feature | Status | Location |
|---------|--------|---------|
| Adaptive Drain HWM | ✅ Full | `adaptiveHwm()` = `floor(HWM_BASE × clamp(120/(ema+10), 0.6, 2.0))`; EMA updated on each push latency |
| Integrated Backpressure | ✅ Full | `maybePostDrain()` posts `worker_drain` when below HWM and below BYTE_DRAIN_HWM (2 MiB) |
| Input Queue Safety Cap | ✅ Full | `MAX_QUEUED_BYTES = 128 MiB` hard cap in `onChunk()` |
| Coalesced Drain Messages | ✅ Full | 8ms `DRAIN_MIN_INTERVAL_MS`; only posts if crossed threshold or interval elapsed |
| Post-Push Budget Check | ✅ Full | `checkBudget()` called in readDecoderEvents before progress pixel transfer |
| Pre-Transfer Budget Check | ✅ Full | Budget checked BEFORE `postMessage(msg, [pixels])` — pixels are live at check point — applies to both `progress` AND `final` events. Verified: 2026-05-25 |
| Budget Graceful Finish | ✅ Full | `postBudgetExceeded` → `finishSession("budget_exceeded")` (graceful, not fail) |
| Terminal-State Wakeup | ✅ Full | `finishSession()` calls both `wake()` and `wakeResume()` — unblocks all sleeping points |
| Disposal Promise Sharing | ✅ Full | `disposePromise` singleton — multiple terminal callers join same promise |
| Single-Emit Metric Guard | ✅ Full | `firstPixelMetricPosted` flag; set on first progress or final event |
| Terminal-Aware Pause Guard | ✅ Full | `onPause()` checks `isTerminal() || paused` before proceeding |
| `onPause` Idempotency | ✅ Full | Guard prevents sending multiple `decode_paused` acks |
| Telemetry for Final-Only | ✅ Full | `postFirstPixelMetric()` called from both `progress` and `final` handlers |
| Execution Budgets | ✅ Full | `budgetMs` from opts; checked per-event against `stageStartMs` (session-level elapsed) |
| Event Iterator Unblocking | ✅ Full | `disposeActiveDecoder()` called in all terminal paths (cancel, fail, budget exceeded) |
| Preemption Pause Boundary | ✅ Full | Pause detected between chunks (next feedDecoder iteration), not mid-push — correct per WASM synchrony invariant |

---

## Bottlenecks & Issues

### 🟢 B1 — Budget check before `decode_final` pixel transfer ✅ FIXED (C2)
**Status: FIXED** — The `final` event handler now calls `checkBudget()` BEFORE `postMessage(msg, [pixels])`, matching the same pattern as the `progress` handler. Fix is at line ~371: `if (this.checkBudget()) { this.postBudgetExceeded("final", event.info, pixels, ...); return; }`. A comment was also added explaining that the check must happen before transfer to avoid sending a zero-length detached buffer.
Verified: 2026-05-25

### 🟡 B2 — `feedDecoder` inner loop drains all available chunks before pause check
The inner `while` loop processes all queued chunks before calling `maybePostDrain()` and checking pause. If many chunks are queued and `decoder.push()` is slow, the pause response is delayed by the length of the remaining queue.
**Impact:** Acceptable per CLAUDE.md invariant — push is synchronous and can't be interrupted mid-chunk. Hard cancel is soft between chunks.

### 🟡 B3 — `compactQueue` uses `copyWithin` (no-alloc) but only when threshold met
Threshold at 64 (readIndex > 64 && readIndex * 2 > length). This avoids premature compaction (reduces churn). Per CLAUDE.md: "compactQueue threshold < 64 increases array churn." ✅ Correct as-is.

### 🟢 B4 — EMA alpha = 0.25 (faster response than scheduler's 0.2)
decode-handler's HWM EMA uses alpha=0.25 vs scheduler's alpha=0.2. decode-handler needs faster response to push latency changes (worker-side). Scheduler needs slower response to drain round-trip latency. Appropriate differentiation.

---

## Key Invariants

- `stageStartMs` set at construction — budget is session-elapsed, not per-stage. No per-stage reset.
- `finishSession()` is idempotent via `this.ended` guard. First call wins; subsequent calls are no-ops.
- `onPause()` posts `decode_paused` synchronously, before `feedDecoder` detects the pause flag. Worker may still be running mid-push; scheduler awaits the ack before reassigning.
- `takeNextChunk()` nulls the slot after reading — allows GC of transferred ArrayBuffers before next compaction.
- `disposeActiveDecoder()`: stores `decoder = null` before creating promise — prevents a second call from double-disposing.
- `postBudgetExceeded` uses the live `pixels` ArrayBuffer (not yet transferred). The `checkBudget()` guard runs BEFORE postMessage to ensure the buffer is still valid.
