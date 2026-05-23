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
*   **`PoolWorkerState` discriminated union (Round11-3b):** Splitting `activeSessionId` into a separate `state: "idle" | "reserved" | "active" | "cancelling"` field was rejected. The reserved sentinel constant (`RESERVED_SESSION_ID`) achieves the same lifecycle guard with no interface churn. Adding a state field would require updating `PoolWorker` in `types.ts` plus every read site in `scheduler.ts`, for no measurable correctness gain beyond what `bind()` validation already provides.

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

## `src/lib.rs` / `web/jxl-wrapper-lab.js` / `web/jxl-benchmark.js` (WASM Resizer)
*   **`fast_image_resize` crate (Gemini spec):** Rejected. The crate's v2 API (`NonZeroU32`, `Image::from_slice_u8`, `Resizer::new(ResizeAlg::...)`) is outdated — v3 changed the interface. Introduces a new build dependency for no quality benefit over a box filter for thumbnails. Existing `downscale_rgb` pattern extended to 4 channels instead.
*   **`ResizedImage` struct with `unsafe take_rgba` (Gemini spec):** Rejected. `take_rgba(self)` consumes the struct, dropping `self.pixels`; `Uint8Array::view` then points to freed memory — undefined behaviour. Correct pattern (`Vec<u8>` return via wasm-bindgen copy) follows `downscale_rgb` and is used by `downscale_rgba`.

## `packages/jxl-worker-node/src/worker.ts`
*   **`worker_ready` backendStatus / protocol churn (Node-R1-9):** Extending `worker_ready` with `backendAvailable: boolean` or posting `worker_error` before `worker_ready` on total backend failure is protocol churn not justified by the failure frequency. The `backendPromise` singleton already ensures `backend` is set before `worker_ready` is posted; sessions that subsequently fail backend init report `CapabilityMissing` via the normal session-error channel. Reporting "wasm" as fallback type on total failure is a documented contract, not a misleading claim.

## `packages/jxl-worker-browser/src/worker.ts`
*   **Generic `handleSessionStart<T>` with `SessionStartOptions<T>` (Facade-R1-1):** Correctness bug — success path never calls `pendingStarts.delete(sessionId)`. After `onSessionEnd` removes the session from `decodeSessions`, the resolved promise remains in `pendingDecodeStarts`, causing `hasAnySession()` to return `true` and subsequent reconnect attempts to get a false `DuplicateSession` error. Also: `SessionStartOptions<T>` interface adds cognitive overhead for ~20 lines of honest duplication between two clearly distinct functions.
*   **Generic `queueMessage` / generic `flushQueuedMessages` (Facade-R1-2):** `Map<string, any[]>` parameter and `(handler: T, msg: any) => void` callback regress type safety relative to the existing explicit typed functions. The `instanceof DecodeHandler` check inside the flush callback leaks abstraction internals and signals the generic boundary is wrong.
*   **`cleanupSession(sessionId)` helper (Facade-R1-3):** Deletes from all 6 maps unconditionally. Breaks `handleReleaseState`, which must retrieve handlers *before* deletion to call `onCancel` on them. Also crosses decode/encode ownership boundaries in per-path error cleanup, where only the relevant side's maps should be touched.
*   **`cleanupSessionForAll()` for shutdown (Facade-R1-4):** Extracts 6 already-clear `.clear()` calls into a named function. No semantic gain; the existing inline block is self-evident.
*   **`queuedDecodeMessages`/`queuedEncodeMessages` checks in `hasAnySession` (Facade-R1-5):** Queued message entries only exist while a pending start entry for the same session is present — they are created and deleted together. Adding checks for this impossible orphan state adds noise without enforcing the invariant at the write site. If the invariant can be violated, the fix belongs at the point of mutation.
*   **Parameterized `errorType` in `queueDecodeMessage`/`queueEncodeMessage` (Facade-R1-6):** These are separate, type-specific functions; the hardcoded strings are correct by construction. Adding an `errorType` parameter adds indirection with no benefit unless the functions are merged into a generic — which was itself rejected.
