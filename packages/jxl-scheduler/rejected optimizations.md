# Rejected Optimizations — jxl-scheduler

---

## 1. Micro-batched send
Worker protocol has no `batch` message type; can't implement the scheduler half without the worker half.

## 2. Pull-based worker input
Correct long-term direction, but requires protocol inversion (`worker_ready_for_chunk`), per-session ring buffers, and a new backpressure model — too large to do safely in isolation.

## 3. DispatchGroup fan-out collapse
`forEachSubscriber` is already zero-alloc; a merged flat list would add invalidation on every `subscribe`/`onMessage`/`cancelSession` call (common path) to benefit the multiple-subscriber case (uncommon).

## 4. Numeric priority lanes (`const enum`)
tsc would inline them, but the churn of touching every priority comparison outweighs a marginal branch-prediction gain.

## 6. Smarter preemption victim selection — superseded
Resolved: `createdAt` (client-side, no protocol change) is sufficient; implemented in the SessionRecord refactor.

## 7. Soft preemption
Proposed: send `decode_yield_request` to the victim worker; if it responds with `decode_yielded` within 300ms, avoid a hard cancel.

Rejected for three compounding reasons:

1. **No benefit at the natural yield point.** `DecodeHandler.feedDecoder` already exits cleanly at chunk boundaries: `onCancel` sets `this.cancelled` and wakes `wakeResolve`, so the loop terminates at its next iteration. Hard cancel is already "soft" when the decoder is between chunks.

2. **No benefit mid-push either.** When `decoder.push(chunk)` is actively running, WASM executes synchronously to completion — it cannot be interrupted. The 300ms grace window would simply time out and fall back to hard cancel, adding latency without saving anything.

3. **"Pause and resume" is not available.** To make yield genuinely useful (spare the caller a full resubmit), the decoder would need to serialise its internal state and resume on the same worker later. libjxl has no such API and the WASM adapter does not expose one. A yield that still destroys decoder state is indistinguishable from cancel with extra round-trips.

Progress-aware victim scoring (implemented) is the correct lever: avoid preempting nearly-done sessions entirely rather than trying to preempt them gently.

## 8. SessionRecord consolidation — implemented
All 6 maps collapsed into `sessions: Map<string, SessionRecord>`.

## 10. Promise-per-session alternatives
Premature — needs profiling evidence that promise churn is material before adding complexity.

## 11 & 12. Worker warmup / adaptive concurrency
Heuristics require real benchmark data to tune; wrong to add machinery for thresholds that aren't grounded yet.

## 14. Latest-frame coalescing
Only useful for progressive decode previews; the actual message cadence through this path wasn't confirmed, so adding it without that knowledge would be speculative.

## 15. Dev-mode transfer guard
Zero performance impact; not worth the complexity gate.

## 16. CircularBuffer for `bufferedChunks`
Queued sessions are the minority case and the array is drained and GC'd the instant a worker is assigned — ring buffer adds ~40 LOC with no measurable gain.

## 17. Flat merged handler list for dedupe fan-out
Same conclusion as #3 post-SessionRecord: the per-subscriber lookup is already O(1) per subscriber; merged list invalidation costs more than it saves at typical subscriber counts.

## 18. `onMetrics` callback
Fires on every `assignWorker`, preemption, and terminal message even with no consumer — non-zero overhead at the hottest points; replaced by polling via `getMetrics()`.

## 19. Session-level `timeoutMs` on `acquireSlot`
`AbortSignal.any()` isn't universally available, manual signal combination has listener-leak risk, and no current caller needs it.

## 20. Third priority lane
`"near"` is in the `Priority` type but unused in scheduling logic; no current consumer justifies wiring it through.

## 21. DrainQueue batch-acquire
The drain loop already acquires workers as fast as `pool.acquire()` resolves — workers become free asynchronously so there is nothing to collapse into a batch.

## 22. Worker reuse hinting (session-type affinity)
Requires a `pool.acquirePreferred(hint)` API addition and evidence that WASM module re-initialisation (not cache) is the actual bottleneck; no benchmark data for either.

## 23. Preemption rate limiting / cooldown
With typical `maxWorkers` (4–8), sustained preemption storms require that many simultaneous `visible` arrivals with all slots occupied by `background` — not a realistic steady state; add if benchmarks show otherwise.
