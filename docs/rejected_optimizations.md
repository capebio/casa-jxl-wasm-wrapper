# Rejected Optimizations

This document records optimization proposals that were evaluated and rejected.

## `packages/jxl-scheduler/src/scheduler.ts`
*   **Micro-batched send (1):** Requires protocol inversion; worker lacks `batch` message type.
*   **Pull-based worker input (2):** Too large for isolated implementation; needs new backpressure model.
*   **DispatchGroup fan-out collapse (3):** `forEachSubscriber` is zero-alloc. Merged list adds invalidation overhead on every common operation (`subscribe`/`cancelSession`), hurting the common case.
*   **Numeric priority lanes (4):** The code churn of updating priority comparisons outweighs the marginal branch-prediction gain.
*   **Smarter preemption victim selection (6) [Superseded]:** Resolved via `createdAt` in SessionRecord refactor.
*   **Soft preemption via yield message (7):** WASM executes synchronously and cannot yield mid-push. Hard cancel is already soft between chunks. Pause/Resume is implemented structurally without this.
*   **Promise-per-session alternatives (10):** Premature optimization. Needs profiling to prove promise churn is a bottleneck.
*   **Worker warmup / adaptive concurrency (11, 12):** Requires real benchmark data to tune heuristics properly.
*   **Latest-frame coalescing (14):** Speculative addition. Actual message cadence wasn't confirmed.
*   **Dev-mode transfer guard (15):** Zero performance impact; not worth the complexity.
*   **Flat merged handler list for dedupe (17):** Same as #3. O(1) per-subscriber lookup is fine; invalidation costs too much.
*   **onMetrics callback (18):** Replaced by polling (`getMetrics()`). Callbacks add overhead at hot points (worker assignment, preemption).
*   **Session-level timeoutMs (19):** `AbortSignal.any()` isn't universal. No current caller needs it.
*   **Third priority lane ("near") (20):** Unused in logic; wiring it through is unjustified without a consumer.
*   **DrainQueue batch-acquire (21):** Workers free asynchronously; nothing to collapse into a batch.
*   **Worker reuse hinting (22):** Requires new API and proof that WASM module re-initialization (not cache) is a bottleneck.
*   **Preemption rate limiting (23):** Not a realistic steady state with typical `maxWorkers` (4-8). Needs benchmarks.
*   **All-or-Nothing Preemption (10):** Addressed structurally; pause/resume is now handled without abandoning the decode state.

## `packages/jxl-scheduler/src/pool.ts`
*   **Worker warmup / adaptive concurrency (11, 12):** Same reasoning as above.

## `packages/jxl-wasm/src/facade.ts`
*   **onDrain callback on JxlDecoder (R1-1, R2-3, DH6-B):** Backpressure is managed at the scheduler/worker boundary. Pushing it into the WASM bridge duplicates logic at the wrong layer.
*   **Shared pixel buffer pool (R1-2, R2-2, DH-9):** Cannot safely recycle transferred `ArrayBuffer`s without an explicit `release()` lifecycle that consumers don't implement.
*   **decodeLowResFirst option (R1-3):** Covered by existing `downsample: 8` + `progressionTarget: "dc"` options.
*   **decodeBatch() on facade (R1-4):** Wrong layer. Batching, dedupe, and preemption belong in the scheduler.
*   **Adaptive quality/distance via connection (R1-7):** Network state is an application concern. Facade should not acquire it.
*   **Worker-side header caching (R1-8, DH6-C):** Breaks the stateless worker model. Handled by `DedupeRegistry` in the scheduler.
*   **ReadableStream/WritableStream APIs (R1-9, R2-5):** Thin ergonomic wrappers with no performance benefit. Better suited as separate utilities.
*   **Error recovery / partial resume (R1-10):** Not supported by libjxl C API.
*   **Streaming EncodeEvent from chunks() (R2-1):** Breaking API change. `getStats()` provides this without forcing hot-path unions.
*   **refineRegion() on JxlDecoder (R2-4):** Requires caching massive compressed inputs post-decode. Caller should create a new session instead.
*   **DeferredVoid class (R3-3):** Single-slot invariant is structurally guaranteed. Adds unnecessary allocation.
*   **Pooled WASM input buffer (R3-7):** Unsafe for concurrent sessions sharing a module. Minor malloc savings don't justify the risk.
*   **Option normalisation into constructor (R3-10):** Adds LOC and interfaces for cheap derivations. No measurable runtime win.
*   **pushBorrowed() / pushOwned() methods (R3-13):** Bloats public API. The `copyInput` constructor option suffices for production.
*   **Bounded input queue / async backpressure (R3-14, R3-15):** Redundant in worker path due to scheduler HWM. Deferred until direct-use consumers need it.
*   **Cap first progressive push to 64 KB (R3-16):** Complicates inner loop for a rare case. Batching throughput outweighs latency in steady state.
*   **Defensive Slicing (B-2, R4-4):** False claim. The hot path (`ArrayBuffer` from postMessage transfer) wraps with zero copy. `copyInput: false` handles the rest.

## `packages/jxl-wasm/src/bridge.cpp`
*   **Redundant Copy (B-1):** False claim. `libjxl` writes directly into the `malloc`'d buffer via `JxlDecoderSetImageOutBuffer`. No intermediate `memcpy` exists.

## `packages/jxl-worker-browser/src/decode-handler.ts` & `packages/jxl-worker-node/src/decode-handler.ts`
*   **Worker-side createImageBitmap (R4-2):** Invalid MIME type (`image/x-rgba8`), breaks 16-bit/float formats, and mixes DOM logic into an agnostic worker.
*   **Pixel buffer pool for output (DH-2):** Transferred buffers detach. No safe return mechanism.
*   **Progress event throttling (DH-3):** Suppresses intended progressive UX. No data showing message rate is a bottleneck.
*   **Improved compactQueue() (DH-4):** Inline nulling already handles GC. Lower threshold increases array churn.
*   **Global + rolling-window budget (DH-5, DH6-5):** `stageStartMs` already measures global elapsed time correctly.
*   **Pixel dump on pause (DH-6):** Redundant. Last `decode_progress` already delivered the state.
*   **Metrics expansion (DH-7, DH6-3):** Protocol churn for marginal debug value.
*   **Error context enrichment (DH-8):** Requires protocol changes. Proposed byte math was incorrect.
*   **Explicit dispose() method (DH-10):** Ambiguous. `onCancel()` and `finally` blocks already handle full teardown.
*   **Preemption-aware soft yield (DH6-1):** Structurally unreachable. Pausing handles this cleanly.
*   **Early header propagation hint (DH6-2):** Duplicates `decode_header` message.
*   **Adaptive chunk batching (DH6-4):** Semantic no-op for WASM pushes, but degrades backpressure granularity.
*   **JXL signature check on first chunk (DH6-6):** Duplicates libjxl logic. Fragile due to multiple valid container starts (bare vs BMFF).
*   **Worker-side decode timeout (DH6-8):** Duplicates scheduler `budgetMs`. Wall-clock timeouts fail on valid slow networks.
*   **Edge-triggered worker_drain (DH7-7):** Risks stalling if queue starts below HWM and never crosses the threshold.
*   **attachRegion helper (DH7-12):** Not enough call sites to justify abstraction.

## `packages/jxl-cache/src/browser.ts` & `packages/jxl-cache/src/lru.ts`
*   **OPFS FileSystemSyncAccessHandle (Cache-9):** Runs in main/shared thread; sync handles are dedicated-worker only.
*   **Deduplication-Aware Caching (G2-1):** Wrong layer. Scheduler deduplicates; cache should not duplicate storage entries.
*   **Memory Pressure-Aware Eviction (G2-2):** `performance.memorypressure` is non-standard/unimplemented. LRU limit is the correct mechanism.
*   **Concurrent Set Coalescing (G2-3):** Inverts semantics. Last caller should win to ensure the freshest data is saved, not the first.
*   **getStream() Helper (G2-5):** Cross-package coupling for a thin wrapper.
*   **OPFS Write Retry Loop (G2-6):** Duplicates existing `QuotaExceededError` handling in `setPersistent`.
*   **Cache-Aware DecodeSession Wrapper (G2-7):** Event-driven sessions cannot be easily faked from a static buffer without knowing protocol internals.
*   **Persistent Cache Buffer Validation (G2-9):** Cache is content-agnostic. Leave format validation to libjxl.

## `packages/jxl-stream/src/browser.ts`
*   **Adaptive Prefetch Depth (G2-8):** Multi-ahead prefetch risks queueing beyond worker limits (128MiB cap). The current one-ahead prefetch is correct.
