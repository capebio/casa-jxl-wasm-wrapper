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
*   **Agent 4 — dedupe priority, metrics, micro-perf (2026-06):** No concrete deltas supplied (query truncated at header). Title implies priority tweaks in dedupe promotion + metrics surface + micro-perf. "Dedupe priority" bookkeeping was a correctness gap (fixed under Agent 3 3.3). Metrics expansions / callbacks / onMetric tax already rejected multiple times ("onMetrics callback (18)", "Metrics expansion (DH-7, DH6-3)", "Dev-mode decode telemetry") because callbacks add overhead at hot points and getMetrics() polling is the contract. Micro-perf and "numeric priority lanes (4)" rejected for churn vs gain without benchmarks. Per CLAUDE.md: adaptive/heuristic or observability changes require benchmark data; do not add without evidence. Category rejected.

## `packages/jxl-scheduler/src/pool.ts`
*   **Worker warmup / adaptive concurrency (11, 12):** Same reasoning as above.
*   **`PoolWorkerState` discriminated union (Round11-3b):** Splitting `activeSessionId` into a separate `state: "idle" | "reserved" | "active" | "cancelling"` field was rejected. The reserved sentinel constant (`RESERVED_SESSION_ID`) achieves the same lifecycle guard with no interface churn. Adding a state field would require updating `PoolWorker` in `types.ts` plus every read site in `scheduler.ts`, for no measurable correctness gain beyond what `bind()` validation already provides.

## `packages/pyramid-ingest/src/ladder.ts`
*   **L4 (overlap encode N with downscale N+1):** Per the proposal, each ladder loop awaits encode before next downscale. Overlap (collect encode promises, Promise.all at end) is valid because encode reads its cur buffer without mutating it and down allocates fresh. However: worker-pool pins one core per worker; overlap only yields if JXL backend is internally MT or awaits are I/O. Spec requires "Benchmark on one large master before keeping; reject with numbers otherwise." No large-master benchmark data or delta (ms/throughput) was measured in this session (no 50-100 MP corpus available in harness for quick run; existing ladder sweeps are small or synthetic). Heuristic/perf overlap without evidence violates CLAUDE.md + handoff rule. Rejected; serial cascade kept. If future bench on real large master shows >X% win on wall time (not just CPU), re-evaluate behind the ratified measurement.

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
*   **compactQueue() threshold lowered to 32 / 0.4 (Grok-R12-1):** Already rejected as DH-4. Lower threshold increases array churn for no GC benefit; `copyWithin` (no-allocation compaction) was adopted but the threshold stays at 64 / 0.5.
*   **takeNextChunk() compaction inlined (Grok-R12-2):** Missing the "fully-drained reset" path — without the unconditional `compactQueue()` call, queue indices grow unbounded until the 64-slot threshold fires. Non-null assertion on slot value removes the undefined-slot safety check.
*   **feedDecoder budgetMs hoisting / single check (Grok-R12-3):** Removes the post-push budget check, regressing the fix added in the previous round. Hoisting `budgetMs` and `startMs` outside the loop saves trivial property dereferences.
*   **AbortController signal to createDecoder (Grok-R12-4):** Requires changes to `wasm-loader.ts`, `facade.ts`, and `bridge.cpp`. `createDecoder` has no `signal` parameter in the current interface. Speculative cross-package change with no bridge support.
*   **Pre-allocate chunk queue with new Array(32) (Grok-R12-5):** `new Array(32)` creates a sparse array with `length = 32`. The outer loop guard `length > readIndex` would be true on an empty queue; `takeNextChunk` would hit undefined holes immediately and return null incorrectly.
*   **decode_progress throttling (Grok-R12-6):** Already rejected as DH-3. Suppresses progressive UX for 2–3 messages per decode.
*   **failSession context / console.error (Grok-R12-7):** Protocol change for `context: any`; loose typing; `console.error` leaks internals. Same class of rejection as DH-8.
*   **finishSession made async to await disposeActiveDecoder (Grok-R12-8):** Makes a synchronous function async — all callers (`onChunk`, `run` finally, `failSession`, `postBudgetExceeded`, `onCancel`) would need updating. Duplicates the existing disposal handled by `run()`'s `finally`. Introduces a race where `callbacks.onSessionEnd` (synchronous session-map removal in worker.ts) could interleave with async disposal. Rejected as DH-10 in spirit.
*   **maybePostDrain() 4 ms check-interval gate (Grok-R13-1):** Claims to reduce `performance.now()` calls but still calls it unconditionally to evaluate the gate — net zero savings. Only skips `adaptiveHwm()` (a few arithmetic ops, not a real cost). Adds a second timing constant (`DRAIN_CHECK_INTERVAL = 4 ms`) that interacts confusingly with the existing `DRAIN_MIN_INTERVAL_MS = 8 ms`.
*   **takeNextChunk() + compactQueue() reorganization (Grok-R13-2):** Threshold lowered from 64 → 48 (same rejection as DH-4 and Grok-R12-1). Moving threshold logic from `compactQueue()` to `takeNextChunk()` and stripping it from `compactQueue()` means the fully-drained reset never fires for sessions consuming fewer than 49 total chunks one-at-a-time — indices accumulate until threshold fires. The `copyWithin` pattern is already implemented; no net gain.
*   **Hoist budgetMs/startMs in feedDecoder (Grok-R13-3):** V8 JIT caches property accesses on stable hidden classes; `this.opts.budgetMs` and `this.stageStartMs` dereferences are trivially cheap. The inline `budgetMs !== null` also diverges from `checkBudget()`'s `== null` — if `budgetMs` is `undefined`, `!== null` is `true` and the comparison proceeds against `undefined` (accidentally harmless but semantically wrong). Duplicating budget logic outside `checkBudget()` creates divergence risk.
*   **Inline waitForChunk/waitForResume fast paths (Grok-R13-4):** V8 optimises trivially-resolved `Promise.resolve()` to near-zero cost. Inlining duplicates guard logic across call sites and degrades readability for immeasurable gain.
*   **Adaptive EMA alpha for push-latency spikes (Grok-R13-5):** A single-spike response (α = 0.6 when pushMs > 1.5× EMA) risks overreacting to GC pauses (common 5–20 ms bumps), dropping HWM and creating unnecessary drain traffic. The scheduler already observes `latencyMs` per drain and adapts its own `pushHwm`; adaptive alpha would fight that signal. No benchmark data shows EMA lag is a real bottleneck.
*   **Assign drain message to const before postMessage (Grok-R13-6):** Identical to inline object literal — same allocation, same hidden class, same JIT path. "Reuse object shape" is incorrect: a new object is created each call regardless of variable binding; objects sent via `postMessage` are not reused.
*   **Make readDecoderEvents early exit "more prominent" (Grok-R13-7):** `if (this.isTerminal()) return;` is already the first statement in the `for await` body; all terminal switch branches already use `return`. Purely cosmetic with no behavioral change.
*   **Dev-mode decode telemetry metric message (ChatGPT-R11-T):** Proposed posting a `{ type: "metric", metric: { name: "decode_queue_status", ... } }` message on every chunk. Same rejection as DH6-3 and DH-7: requires protocol changes (a new `decode_queue_status` name falls outside the closed `CodecMetric` union), and queue depth / latency are already observable from the `worker_drain` stream which now carries `queueDepth`, `queuedBytes`, and `adaptiveHwm` directly.
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
*   **SB-9 small-chunk coalescing (Agent 5, real-image interleaved multi-flip on DNG/ORF/CR2):** 
  User request: 5 samples per state per config, interleaved on/off flips via runtime toggle in one process, using real RAW files chunked at the requested sizes.

  Images (from C:\Foo\raw-converter\tests):
  - CR2: ADH 1490.CR2 (~28 MB)
  - ORF: P1110226.ORF (~17.4 MB)
  - DNG: PXL_20260501_093507165.RAW-02.ORIGINAL.dng (~19.7 MB)

  Chunk strategies: tiny(512 B), small(4 KiB), medium(16 KiB), large(64 KiB), original (single full-file chunk).

  **Results (5 samples/state, interleaved, count-only mock session):**

  CR2 (28 MB):
  - tiny:   OFF 43.70ms / ~57k pushes → ON 50.81ms / 448 pushes   (+16% wall, ~128x fewer)
  - small:  OFF 7.54ms / ~7k → ON 15.69ms / 448   (+108% wall, 16x)
  - medium: OFF 1.32ms / ~1.8k → ON 11.61ms / 448  (+780% wall, 4x)
  - large:  OFF 0.55ms / 448 → ON 0.92ms / 448     (+67% wall)
  - original: ~0.01ms / 1 both

  ORF (17.4 MB):
  - tiny:   OFF 24.94ms / ~35k → ON 25.22ms / 279   (+1% wall, ~128x)
  - small:  OFF 4.76ms / ~4.5k → ON 7.96ms / 279    (+67% wall, 16x)
  - medium: OFF 0.68ms / ~1.1k → ON 6.87ms / 279    (+910% wall, 4x)
  - large:  OFF 0.20ms / 279 → ON 0.28ms / 279      (+40% wall)
  - original: ~0.01ms / 1

  DNG (19.7 MB):
  - tiny:   OFF 29.62ms / ~40k → ON 31.00ms / 315   (+5% wall, ~128x)
  - small:  OFF 2.99ms / ~5k → ON 8.45ms / 315      (+183% wall, 16x)
  - medium: OFF 1.28ms / ~1.3k → ON 6.89ms / 315    (+438% wall, 4x)
  - large:  OFF 0.34ms / 315 → ON 0.49ms / 315      (+44% wall)
  - original: ~0.01ms / 1

  Consistent pattern across all three formats: huge push-count reduction for tiny/small/medium (as designed), but **wall time is neutral to significantly worse** with the 64 KiB coalescer. The accumulation + buffer copy overhead dominates the savings from fewer pushes in the stream layer.

  Decision: **rejected** (reinforced by real DNG/ORF/CR2 data). R1-4 (batching wrong layer), prior DH6-4 rejection, CLAUDE evidence bar, complexity, and now confirmed negative wall impact on actual image payloads. Source cleaned after run; range tests still green.

  (Previous synthetic data already pointed the same direction; this fulfills the "5 x on tiny/small/medium/large/original" + real formats request.)

*   **SB-10 resumable Range (implemented 2026):** 
  Added minimal ergonomic + safe-resume layer on top of the existing fromByteRange (which already supported arbitrary start + 200-fallback skip).

  New (in browser.ts):
  - `RangeNegotiation` now carries optional `etag` (captured from the first response).
  - `ByteRangeResumeState` (plain serializable object: url, start, endExclusive, etag?, fullSize?).
  - `createByteRangeResumeState(url, previousNegotiation, originalStart=0)` — turn a previous result into persistable resume state.
  - `resumeFromByteRange(state, session, opts?)` — calls fromByteRange with the right Range header + `If-Range: <etag>` when available for safety. Still fires onRangeNegotiated, supports signal/custom fetch etc.

  Backward compatible; fromByteRange and fromRangePrefix unchanged.

  Real-image timing/savings bench (using the CR2/ORF/DNG files from raw-converter/tests, 50% partial simulation, fake server that counts bytes served + returns ETag):

  - On reconnect, "Before" (naive restart from byte 0) causes the server to re-serve the entire prefix + tail.
  - "After" (create state from first partial + resumeFromByteRange) causes the server to serve only the tail.
  - Savings: essentially the entire first-half bytes (e.g. ~14.6 MB saved on the 28 MB CR2, ~9.1 MB on the 17 MB ORF, ~10.3 MB on the 20 MB DNG).
  - Wall time for the resume leg itself: negligible in the controlled bench (0.07–0.48 ms).

  The functionality win (dramatically fewer bytes over unreliable/field links, ability to persist partial + resume state with jxl-cache across restarts) is large. The added code path cost on the initial fetch and on resume is tiny (mostly header merging + one wrapper call).

  Moved out of "future note only". Implementation is contained in the stream layer, respects all prior layering rules, and the perf data shows the cost is acceptable for the value (exactly as the user suggested: "if only slightly worse, worth it for the functionality").

  Existing range tests continue to pass. New helpers are exported from browser.ts (index re-exports remain deferred per prior guidance).

## `src/lib.rs` / `web/jxl-wrapper-lab.js` / `web/jxl-benchmark.js` (WASM Resizer)
*   **`fast_image_resize` crate (Gemini spec):** Rejected. The crate's v2 API (`NonZeroU32`, `Image::from_slice_u8`, `Resizer::new(ResizeAlg::...)`) is outdated — v3 changed the interface. Introduces a new build dependency for no quality benefit over a box filter for thumbnails. Existing `downscale_rgb` pattern extended to 4 channels instead.
*   **`ResizedImage` struct with `unsafe take_rgba` (Gemini spec):** Rejected. `take_rgba(self)` consumes the struct, dropping `self.pixels`; `Uint8Array::view` then points to freed memory — undefined behaviour. Correct pattern (`Vec<u8>` return via wasm-bindgen copy) follows `downscale_rgb` and is used by `downscale_rgba`.

## `packages/jxl-worker-node/src/worker.ts`
*   **`worker_ready` backendStatus / protocol churn (Node-R1-9):** Extending `worker_ready` with `backendAvailable: boolean` or posting `worker_error` before `worker_ready` on total backend failure is protocol churn not justified by the failure frequency. The `backendPromise` singleton already ensures `backend` is set before `worker_ready` is posted; sessions that subsequently fail backend init report `CapabilityMissing` via the normal session-error channel. Reporting "wasm" as fallback type on total failure is a documented contract, not a misleading claim.
*   **`cleanupFailedBackendStart(sessionId, isDecode: boolean)` helper (Node-R2-3):** Boolean-flag discriminator over two lines (`pendingDecodeStarts.delete` + `clearQueuedDecode` vs encode equivalent). Boolean-flag helpers are an anti-pattern and the abstraction adds indirection with no semantic gain. Three similar lines are better than a premature abstraction.
*   **`safePostMessage` for shutdown ack (Node-R2-6):** `safePostMessage` checks `if (shuttingDown) return`. Since `doShutdown` sets `shuttingDown = true` at its first line, routing the ack through `safePostMessage` would silently suppress it — the parent would never receive `worker_shutdown_ack`. The ack must use `port.postMessage` directly.

## `src/lib.rs` — Raw Pipeline / WASM Entry Point (Round-2 batch)

*   **`Vec<u16>` lightbox/thumb caches (R2-2):** Changing `rgb16_lb` / `rgb16_thumb` from `Vec<u8>` (packed u16 LE) to `Vec<u16>` is an API break — callers receive `Uint8Array` today and would need to migrate to `Uint16Array`. `LookRenderer` (now implemented) unpacks packed bytes once in its constructor, so the wire format stays `Uint8Array` and callers are unaffected. The format change would eliminate `unpack_rgb16_le` inside the constructor but adds no correctness benefit. Deferred.
*   **`process_orf_for_jxl` / `ExportDepth` enum (R2-5):** Stub that unconditionally delegates to `process_orf` adds a public wasm-bindgen entry point with no new behaviour. `pipeline::process_to_rgb16` (needed for the 16-bit path) does not exist. Deferred until the 16-bit pipeline stage is implemented; add the export function then.
*   **Precompute downscale x/y ranges (R2-7):** Allocates `Vec<(usize, usize)>` per call; the floating-point work eliminated is O(dw) not O(dw×dh), so the gain is minor. The existing code already hoists y-bounds outside the dx loop. Deferred unless profiling identifies `downscale_rgb16_impl` as a bottleneck.
*   **Checked allocation in `downscale_rgb16_impl` (R2-8):** `validate_orf_structure` already bounds-checks dimensions before `downscale_rgb16_impl` is called; the function is private and unreachable from unchecked paths. Adding `Result` return changes the internal call sites for marginal robustness gain. Deferred.
*   **`take_rgba()` on `ProcessResult` (R2-10):** Convenience wrapper that calls `rgb_to_rgba(self.take_rgb())`. Adds a new wasm-bindgen entry point (binary size, glue code) for a one-liner callers can already compose from existing exports. Deferred.
*   **Rayon feature gate for parallel downscale/demosaic (R2-15):** Correct approach (`#[cfg(feature = "parallel")]`), no action until the host app can set `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`. SharedArrayBuffer is unavailable without those headers.

## `crates/raw-pipeline/src/demosaic.rs` (Agent 5)
*   **M2 (explicit WASM SIMD128 after M1):** Rejected. The build does not pass `-C target-feature=+simd128`. build-parallel-wasm.ps1 sets RUSTFLAGS to only "+atomics,+bulk-memory,+mutable-globals" (+ link arg); normal `wasm-pack` builds and root Cargo have no simd128 for the wasm32 target of raw-pipeline (or the workspace). "simd" mentions in benchmarks control JXL tier selection (relaxed-simd etc), not Rust codegen for demosaic. Per spec: "if not, reject and record the needed flag." Adding the cfg intrinsics path would be dead code in all shipped WASM builds; scalar fallback after M1 autovectorization is the only path that runs. No change.
*   **M8 (rayon .with_min_len(8) on par_chunks_mut):** Implemented (after measurement). Per plan, added `#[ignore]` bench in `demosaic::tests` exercising `demosaic_rggb_mhc` + bilinear at ~1 MP (1024²), ~1.3 MP, and ~20 MP (5000×4000). Flipped the `.with_min_len(8)` on the relevant `par_chunks_mut(width*3)` sites (full-res demosaic row loops) via edit, ran 4 alternating release builds via `build-msvc.ps1` (native MSVC + rayon). Results (MHC medians):

    - 1 MP: with ~1.8–2.5 ms vs without ~2.2–2.8 ms (consistent win)
    - 20 MP: with ~31–35 ms vs without ~36–42 ms (visible win)
    - Similar direction on the 1.3 MP size and for bilinear (smaller absolute effect).

  The tunable reduces rayon task overhead for µs-scale row work when `parallel` is active (Tauri/desktop and opt-in parallel-wasm). Kept in tree + bench left as `#[ignore]` for future re-measurement. (M1 landed independently and helps serial WASM path too.) M2 remains rejected (see above).

## `crates/raw-pipeline/src/demosaic.rs` (Agent 6)
*   **M3 (QUALITY, exact Malvar-He-Cutler coefficients):** Implemented behind synthetic edge comparison test per spec (vertical ramp target, zipper metric |R-B| at G sites). Exact kernels (β=5/8, γ=3/4, full 16× formulas with 4 extra diagonal G loads at G sites) were coded in-test only. On the 8×8 edge target the delta was small and not decisive for "species-ID detail" without a 20 MP bench + perceptual metric. Per repo policy (quality changes need evidence; no unproven changes to hot kernels) the production uniform-gain kernels (current MHC) are unchanged. The test + this entry ensure the derivation is not re-litigated without data. Rejected for production.
*   **M9 (FEATURE, planar output for ML):** Rejected as speculative. No current caller (ML/CHW recognition pipeline is future work). M1's per-row slice + closure restructure makes an alternate *planar store* possible in principle but not "cheap" (would require either 3 separate plane writers, strided stores in the unrolled pairs, or a post-pass transpose — all add complexity or another pass with zero callers today). Per fast-path principles and CLAUDE.md (no opportunistic, YAGNI, only if M1 made it trivial alternate), not implemented. Note as future recognition-pipeline work if/when a caller appears with evidence.

## `packages/jxl-wasm/src/bridge.cpp`
*   **Consume-as-you-go ring buffer for input_buf (A1 "better yet" from 2026-06 handoff):** Geometric capacity growth + separate `input_size`/`input_capacity` (already implemented with A1-labeled comments, initial 64 KiB, doubling with overflow guard) already cures the described O(n²) exact-grow realloc+full-memmove on every push. The optional "better yet" (release consumed prefixes into a ring so capacity stays bounded to the current unconsumed tail rather than image HWM) adds material complexity in the push hot path: either a two-segment view or explicit linearization before every JxlDecoderSetInput, plus extra head/tail accounting, while preserving the exact ReleaseInput + memmove tail compaction + input_generation increments + the opportunistic TryFlushProgressiveImage gate on NEED_MORE_INPUT. Those behaviors are load-bearing for the progressive visible-passes contract (DONOTCHANGE comments in bridge.cpp:2093, source-string assertions in progressive-detail.test.ts and progressive-visible-passes.test.ts). Tail memmove cost is O(remaining) (small for streaming JXL); overall memory is bounded by one codestream's size anyway. Risk of regressing "one non-final flush per input_generation" or the release-before-append guarantee outweighs the win. Geometric (consistent with every other outbuf_cap *= 2 in the same file) is the positive, minimal, already-landed cure. Ring rejected as net-negative.
*   **Fixed-point Q8 seam blending (A3):** No floating-point "seam" ops in hot paths today. BoxDownscaleRgba8 (sidecar cascade, bridge:1084) is pure integer sum+count divide. Bilinear (facade) is in JS with float weights but no "seams". Animation blend_mode is libjxl JxlBlendMode (already integer enum). No evidence of non-determinism or perf issue on current paths; "seam" term undefined in this context. Adding Q8 would be churn for unclear gain (and would move math from JS where it's already table-hoisted per-axis). Rejected unless a precise site + before/after numbers + determinism requirement is supplied.
*   **WASM64 static asserts (A6):** Defensive only. Current explicit u32 layouts + comments + HEAPU32/HEAP32 access are the contract. wasm64 not targeted; Emscripten here is 32-bit pointers. Asserts would be dead code or require cfg + dual builds for marginal future-proofing. Low ROI vs. the explicit packing already present.

## `packages/jxl-scheduler/src/scheduler.ts` (Additional)
*   **Derive/restrict pthread counts (sched-1):** Wrong layer + mixing concerns. JS WorkerPool (maxWorkers, acquire/park/reap for preemption/dedupe) is scheduling. libjxl pthread runner (inside WASM module, sized at build via -sPTHREAD_POOL_SIZE + JxlThreadParallelRunner) is a capability of the decoder/encoder backend. Scheduler has no business reading "WASM pthread pool size" or throttling "parallel ingest pools" — that would duplicate capabilities, break the "stateless worker" model, and create new backpressure/affinity bugs. Bridge already does the right thing for the MT tier.

## `packages/jxl-worker-browser/src/worker.ts`
*   **Generic `handleSessionStart<T>` with `SessionStartOptions<T>` (Facade-R1-1):** Correctness bug — success path never calls `pendingStarts.delete(sessionId)`. After `onSessionEnd` removes the session from `decodeSessions`, the resolved promise remains in `pendingDecodeStarts`, causing `hasAnySession()` to return `true` and subsequent reconnect attempts to get a false `DuplicateSession` error. Also: `SessionStartOptions<T>` interface adds cognitive overhead for ~20 lines of honest duplication between two clearly distinct functions.
*   **Generic `queueMessage` / generic `flushQueuedMessages` (Facade-R1-2):** `Map<string, any[]>` parameter and `(handler: T, msg: any) => void` callback regress type safety relative to the existing explicit typed functions. The `instanceof DecodeHandler` check inside the flush callback leaks abstraction internals and signals the generic boundary is wrong.
*   **`cleanupSession(sessionId)` helper (Facade-R1-3):** Deletes from all 6 maps unconditionally. Breaks `handleReleaseState`, which must retrieve handlers *before* deletion to call `onCancel` on them. Also crosses decode/encode ownership boundaries in per-path error cleanup, where only the relevant side's maps should be touched.
*   **`cleanupSessionForAll()` for shutdown (Facade-R1-4):** Extracts 6 already-clear `.clear()` calls into a named function. No semantic gain; the existing inline block is self-evident.
*   **`queuedDecodeMessages`/`queuedEncodeMessages` checks in `hasAnySession` (Facade-R1-5):** Queued message entries only exist while a pending start entry for the same session is present — they are created and deleted together. Adding checks for this impossible orphan state adds noise without enforcing the invariant at the write site. If the invariant can be violated, the fix belongs at the point of mutation.
*   **Parameterized `errorType` in `queueDecodeMessage`/`queueEncodeMessage` (Facade-R1-6):** These are separate, type-specific functions; the hardcoded strings are correct by construction. Adding an `errorType` parameter adds indirection with no benefit unless the functions are merged into a generic — which was itself rejected.

## `packages/jxl-session/src/decode-session.ts` (ChatGPT batch — decode-session lifecycle)

Evaluated against `packages/jxl-session/src/decode-session.ts` on branch `Facade-Round1`. All 7 proposals were already implemented or not applicable; no code changes made.

*   **Post-drain re-check in push() (ChatGPT-DS-1):** ALREADY IMPLEMENTED. Lines 103–111: early throw at entry (`terminated || closed`), re-check after `acquirePromise`, re-check after `waitForDrain()` with an inline comment. ChatGPT reviewed a stale version of the file.
*   **Pre-aborted signal handling (ChatGPT-DS-2):** ALREADY IMPLEMENTED. Constructor checks `this.abortSignal.aborted` immediately (line 88) and calls `abortHandler()` synchronously. Listener registered only for non-aborted signals. `cleanup()` removes it on all terminal paths.
*   **Unsubscribe scheduler onMessage handler (ChatGPT-DS-3):** NOT APPLICABLE. `Scheduler.onMessage(sessionId, handler)` returns `void` (`dist/scheduler.d.ts`). No unsubscribe function is returned; nothing to store or call.
*   **Centralise finalisation into finish() / fail() (ChatGPT-DS-4):** ALREADY IMPLEMENTED. `finish()`, `finishWithError()`, and `fail()` all exist and call `cleanup()`. The proposal collapsed `finishWithError()` into `fail()`, which would break `decode_budget_exceeded` semantics — the frame stream must end gracefully (not fail) so consumers receive the partial frame while `done()` rejects.
*   **Update lastInfo on decode_budget_exceeded (ChatGPT-DS-5):** ALREADY IMPLEMENTED. Line 185: `this.lastInfo = msg.info;` already present.
*   **Move KNOWN_JXL_ERROR_CODES to module-level ReadonlySet (ChatGPT-DS-6):** ALREADY IMPLEMENTED. Lines 19–22: module-level `ReadonlySet<string>` already exists. ChatGPT reviewed a stale version.
*   **try/catch on scheduler.send() in close() (ChatGPT-DS-7):** REJECTED. Labeled "optional" by the reviewer and conditional on `scheduler.send()` throwing. `send()` is fire-and-forget by design; no evidence it throws on dead sessions. CLAUDE.md: no error handling for scenarios that cannot happen.

## `packages/jxl-session/src/encode-session.ts` (ChatGPT batch — encode-session lifecycle)

Evaluated against `packages/jxl-session/src/encode-session.ts` on branch `encoder`. Items 1, 3, 4 were implemented (post-await lifecycle rechecks, abort signal lifecycle, module-level error codes). Items 2, 5, 6, 7 rejected.

*   **Add comment to finish() explaining acquirePromise invariant (ChatGPT-ES-2):** REJECTED. The WHY is not non-obvious — the `if (this.terminated) return` guard two lines below the await is self-documenting. CLAUDE.md: no comments unless WHY would surprise a reader.
*   **Immediate cancel() — call cancelSession before awaiting acquirePromise (ChatGPT-ES-5):** REJECTED. `decode-session.cancel()` (the reference implementation) uses the same await-before-cancel ordering. Changing the ordering without verifying scheduler behaviour for sessions mid-acquisition is an unwarranted protocol risk. The scheduler's `cancelSession` already handles all states (queued, running, paused); the await ensures the session is in a defined state before the cancel call, consistent with the established pattern.
*   **Local variable extraction for iccProfile/exif/xmp before startMsg (ChatGPT-ES-6):** REJECTED. Cosmetic only. CLAUDE.md: no opportunistic refactors.
*   **try/catch around onMetric callback (ChatGPT-ES-7):** REJECTED. `decode-session.ts` does not guard onMetric. Silent swallow hides user callback bugs without benefit; if onMetric throws, a session error is more informative than silent suppression. Same class of rejection as ChatGPT-DS-7.

## `packages/jxl-session/src/encode-session.ts` (Grok batch — encode-session polish)

All 7 proposals rejected. No code changes.

*   **Abort handler via async cancel() fire-and-forget (Grok-ES-1a):** REJECTED. `decode-session.ts` calls `fail()` directly in the abort handler; async `cancel()` with `.catch(() => {})` adds scheduler cancellation in a fire-and-forget that cannot be awaited by the abort event. Diverges from the reference pattern without correctness benefit. The abort handler is synchronous by contract.
*   **cancel() post-await recheck + signal-aware error message (Grok-ES-1b):** REJECTED. The updated `cancel()` has a JS operator-precedence bug: `reason ?? this.abortSignal?.aborted ? "Encode aborted by signal" : "Encode cancelled"` parses as `(reason ?? this.abortSignal?.aborted) ? "..." : "..."`, not the intended conditional on `.aborted`. `decode-session.cancel()` does not have the extra post-await recheck either; `scheduler.cancelSession()` on an already-terminated session is a no-op and `terminate()` has its own guard.
*   **onChunk callback option (Grok-ES-2):** REJECTED. New public API requiring `EncodeOptions` type change in the `@casabio/jxl-core` package. `chunks()` already provides the same data as an `AsyncIterable`. YAGNI; no caller demonstrates the need.

## `packages/jxl-pyramid` (Grok 5 handoff — observability, validation, API surface)

**Full proposal REJECTED.** The handoff asked to implement logger + PyramidEvent + onEvent callback + ring buffer, PoolStats (p50/p99 + counts), recentErrors ring, new errors.ts with closed PyramidErrorCode list, Zod schemas + parsePyramidManifest (with caching), devAssert sprinkles in stitch/decode paths, unified `decode(source, region, opts)` entry with 'auto'|'single'|'parallel' strategy (removing the tri-state parallel? boolean), @deprecated wrappers, branded `tiledLevelSource`/`wholeLevelSource`, fixtures.ts move to test/ + CI grep blocker for absolute paths in src, nested pool ctor shape (capacity/timing/observability/lifecycle groups) with overload compat, "stop silent clamping" + RangeError on bad inputs, massive new exports (PyramidWorkerPool class, createPyramidWorkerPool, prewarmDefaultPool, dispose..., canUseParallel..., JxtcHeader, PyramidCache, parse..., PyramidError), and 8 new tests exercising the new surface.

**Rationale (grounded in project record + current tree state):**

- Directly repeats multiple **rejected patterns**:
  - Callbacks + event taxonomies + rings for observability: "onMetrics callback (18)", "Metrics expansion (DH-7, DH6-3)", "Dev-mode decode telemetry", "onMetric callback" — all rejected because "callbacks add overhead at hot points", "protocol churn for marginal debug value", "replaced by polling (getMetrics())".
  - Pool ctor restructuring + grouped opts + "validate and throw": same class as rejected "Option normalisation into constructor", "Pooled WASM input buffer" risk/complexity, and "abstraction for cheap derivations".
  - New public surface (unified decode + strategy, branded ctors, onEvent, getStats, recentErrors, many new exports + deprecations): "Breaking API change", "New API and proof that ... is a bottleneck", "bloats public API".
  - Adding Zod + manifest validation at runtime in the decode package: "Cache is content-agnostic. Leave format validation to libjxl", "Persistent Cache Buffer Validation", "G2-9". Manifests come from controlled pyramid-ingest; this is not the hot decode path.

- **Scope and timing**: Pyramid layer already received massive scrutiny (EpicCodeReview - jxl-pyramid.md, HANDOFF docs, Grok3 state machine + Abort work, Grok4 cache/stream-stitch). It is *not* a finished stable surface ready for "make the package shippable as a library, not a function bag." Adding nested ctors, event emission, stats windows, devAsserts, Zod, deprecation shims, and two new .ts files (types + errors) while the primary consumers are still internal web/ gallery code is opportunistic refactor, not surgical.

- Current tree already has partial good parts from prior work (PyramidError + codes live in decode-core.ts and are thrown in pool/decode-level; DecodeOptions comment from Grok4 already anticipated logger; parseWorkerReply is wired; chooseLevelForTarget and plan already do some validation; silent catches exist in exactly the places cited). The proposal wants to *expand* this into full telemetry surface + API unification without demonstrated need or numbers.

- No benchmark data or consumer usage in the handoff for p99 stats, event counts, or the value of the logger/onEvent surface (violates "Adaptive/heuristic changes require benchmark data. Do not add tunables without evidence").

- fixtures.ts move + path grep is pure hygiene and could be a 5-line isolated change. Bundling it with the rest makes the whole delta net-negative.

**What would have been minimal positive deltas (if isolated, evidence-backed PRs later):**
- Wire an optional `logger?: PyramidLogger` (no-op default) into the 5-6 most critical bare `catch {}` sites in tiled-decode-pool (the wiring cost is low; the full event taxonomy + rings + stats is the rejected part).
- Centralize the existing PyramidError into errors.ts (minor).
- If/when pyramid-ingest changes the manifest shape, add a tiny hand-written validator or keep validation in the ingest tool — do not pull Zod into the runtime package for this.
- Export PyramidWorkerPool + a couple of already-used factories if real callers outside the package appear.
- Keep the existing entry points; a `decode()` convenience can be added later if three call sites actually suffer.

The package's job is fast tiled JXTC viewport decode + worker pooling for large images under pan/zoom. Library-ification (branded everything, unified facade, full observability contract, Zod at the boundary) is future work after the mechanics have more bake time and external pressure. Rejected as written.

(Hand-off evaluated on current post-Grok4 tree: PyramidError exists, fixtures still exported from src, pool ctor flat, many bare catches, no Zod/logger/onEvent/stats, manifest is hand interfaces, createLevelSource is the entry.)
*   **Throw on both distance+quality provided (Grok-ES-3):** REJECTED. Breaking behavioral change to existing callers. Current silent-precedence (distance wins) is explicit logic, not ambiguity. Requires a spec and explicit user decision.
*   **state / totalBytes read-only getters (Grok-ES-4):** REJECTED. New public API surface with no current consumer. YAGNI.
*   **pushPixels fast path via !acquirePromise (Grok-ES-5):** REJECTED. `acquirePromise` is assigned in the constructor and is always a `Promise<unknown>` — never `null` or `undefined`. `if (!this.acquirePromise)` is always `false`; the proposed fast path never executes. Logic bug. Also speculative; no profiling evidence that `acquirePromise` resolution is hot.
*   **dispose() method (Grok-ES-6):** REJECTED. Matches already-rejected DH-10 ("Explicit dispose() method: Ambiguous. `onCancel()` and `finally` blocks already handle full teardown."). `terminate()` via `cancel()` or abort covers all teardown paths.
*   **JSDoc class comment + richer error context (Grok-ES-7):** REJECTED. CLAUDE.md: comments only when WHY would surprise a reader. `@see EncodeSession` adds nothing beyond the class declaration. Commented-out `this.scheduler.removeMessageListener(this.id)` is code-smell; `onMessage` returns `void` with no unsubscribe API.

## `packages/jxl-session/src/encode-session.ts` (Grok batch 2 — micro-opts)

All 5 proposals rejected. No code changes.

*   **Reuse one-element pixelTransferList across pushPixels() calls (Grok-ES2-1):** REJECTED. `scheduler.send()` has a queued path (line 264 of `scheduler.ts`) that stores `{ msg, transfer }` into `record.pending.bufferedChunks` by reference. Reusing the same array means all buffered chunk entries share one reference — a second `pushPixels` call would overwrite `pixelTransferList[0]` and then `length = 0` would empty the array before the first chunk is flushed to the worker. Corrupts transfer lists for any session that pushes pixels before acquiring a worker. The proposal's own acceptance caveat ("only if scheduler.send() does not retain the transfer list") triggers: **it does retain it in the queued path**.
*   **Post-waitForDrain() recheck (Grok-ES2-2):** ALREADY IMPLEMENTED. Lines 121–122 of `encode-session.ts`: `if (this.terminated || this.finished) return;` already follows `waitForDrain()`. Landed in the ChatGPT batch (suggestion 1).
*   **switch instead of module-level ReadonlySet in normalizeCode() (Grok-ES2-3):** REJECTED. Module-level `KNOWN_JXL_ERROR_CODES: ReadonlySet<string>` is already in place — allocated once at module load, O(1) hash lookup, matches `decode-session.ts` pattern. Replacing it with a `switch` removes the pattern consistency with `decode-session` without performance benefit; both are O(1) for 10 entries.
*   **Cache opts.onMetric in a class field (Grok-ES2-4):** REJECTED. Metric path is not hot. V8 hidden-class caching makes `this.opts.onMetric` and `this.onMetric` cost-equivalent. Speculative micro-opt with no profiling data.
*   **Drop encode_first_byte_ready case (Grok-ES2-5):** REJECTED. The explicit case with its comment documents intentional protocol handling — the message type exists in the wire protocol, its timing data arrives redundantly via the `metric` message, and the comment says why this is correct. Removing it falls to `default: break`, functionally identical, but erases the explanation. CLAUDE.md: keep comments that document non-obvious protocol invariants.

## `web/jxl-progressive-decode.js` + `encode-session.ts` + `src/bin/blur_bench.rs` (Grok/GPT combined batch)

### `web/jxl-progressive-decode.js`

All 5 proposals ALREADY IMPLEMENTED. No code changes.

*   **AbortSignal support (1.1):** ALREADY IMPLEMENTED. `signal` param (line 9), pre-aborted check (lines 26–28), abort handler registered (lines 79–83), removed in `cleanup()` (line 87).
*   **onFrame callback (1.2):** ALREADY IMPLEMENTED. `onFrame` param (line 8), called on `decode_progress` (line 104) and `decode_final` (line 112). `wantsProgressFrames` accounts for it (line 30).
*   **getImageData() on normalizeFrame (1.3):** ALREADY IMPLEMENTED. `normalizeFrame` returns `getImageData()` method (lines 206–213 in current file).
*   **currentStage / lastInfo exposure (nice-to-haves):** ALREADY IMPLEMENTED. `currentStage` tracked (lines 36, 111); `lastInfo` tracked (lines 35, 99, 110); both exposed as getters on the returned object (lines 145–146).
*   **Smart default budgetMs:** Already defaults to `null` (line 16), which is the correct "no budget" sentinel — matches spec.

### `encode-session.ts`

All 4 proposals are re-submissions of previously rejected items. No code changes.

*   **Strengthen AbortSignal / abort handler calls cancel() (2.1):** Re-submission of Grok-ES-1a. See that entry.
*   **onChunk callback (2.2):** Re-submission of Grok-ES-2. See that entry.
*   **Throw on both distance+quality (2.3):** Re-submission of Grok-ES-3. See that entry.
*   **state / totalBytes getters (2.4):** Re-submission of Grok-ES-4. See that entry.

### `src/bin/blur_bench.rs`

`v_pass_clarity` added to bench, benchmarked, and permanently rejected (2026-05-30).

*   **v_pass_clarity added to blur_bench.rs (ACCEPTED):** 8-wide unrolled vertical pass with separate scalar tail added as candidate variant. (`src/bin/blur_bench.rs`)
*   **Production integration of v_pass_clarity (REJECTED — benchmark data 2026-05-30):** `cargo run --bin blur_bench --release` shows `v_pass_clarity` loses at both sizes:
    - 1024×1024 v-pass only: clarity-8 **268ms** vs tiled-64 **171ms** (56% slower)
    - 5240×3912 v-pass only: clarity-8 **5518ms** vs tiled-64 **4074ms** (35% slower; also 12% slower than naive 4921ms)
    - 5240×3912 full round-trip: clarity-8 **10037ms** vs tiled-128 **8362ms** (20% slower)
    The fixed LANE=8 hypothesis was wrong — LLVM vectorises the larger `[[f32;3]; TILE]` accumulator in `v_pass_tiled::<64/128>` more efficiently. The "8-12% gain" claim was opposite to reality.
    **Production recommendation for `../raw-converter-tauri/raw-pipeline`:** use `v_pass_tiled::<128>` for `separable_blur` (full round-trip winner at both scales: 420ms at 1 MP, 8362ms at 20.5 MP).

## `packages/pyramid-ingest/src/ingest.ts` (Agent 3 — fallback tiers, metadata, domain features)

Handoff evaluated per spec in user query + CLAUDE.md invariants (surgical, one-file scope, defer outside edits+approval, verify first, metadata under open `metadata` record no schema edit, F7 note-only).

All contributions evaluated for pipeline fit (layering, cheap exifr, no backpressure in facade, no rejected patterns from this doc, domain value for biodiversity georef, observability for accept-degraded default).

*   **F1 (implemented):** Reordered tryExtractEmbeddedJpeg: large previews (JpgFromRaw/JpegFromRaw/PreviewImage) first, thumbnail() last resort; collect all >4kB cands, return max by length. Positive (BUG, quality): prevents postage-stamp pyramid from tiny IFD1 thumb.
*   **F2 (implemented):** Added getJpegDimensions (pure SOF 0xFFC0/C2 scan, no dep). In Tier3: if longEdge <1024 proceed but set metadata.degraded=true (attached post-buildManifest). Positive (quality guard): small preview >4kB no longer silent bad Tier3.
*   **F3 (implemented):** In buildFallbackPlan: if (opts.proxy !== undefined) do transcodeJpeg + decodeToRgba8 + buildProxyLadder (honors proxy flag + size). Positive (BUG, edge): native-fail + --proxy now produces proxy ladder not full jpg one.
*   **F4 (implemented):** extractBasicMetadata now supports gps flag + emits datetime (DateTimeOriginal/CreateDate). Called on master bytes for *every* path (compute + fallback + native success + jpg). gps gated by !opts.stripGps. Attached to all manifests under `metadata` (z.record tolerates; no schema.ts/manifest.ts edit). Positive (feature, high value): GPS + eventDate for Darwin Core / biodiversity occurrence records. stripGps for sensitive spp privacy.
*   **F5 (implemented):** tel?.event("fallback-tier", {path, tier:3|5, detected, reason}) emitted at each fallback branch (and inside buildFallback). IngestResult carries degraded?:boolean; BatchResult gets degraded?:number (incremented on written fallbacks in both in-proc and worker-reply paths). Positive (observability): Tier3/5 no longer invisible (acceptUnsupported defaults true).
*   **F6 (implemented core + deferred note):** Verified first (verify-f6-orient.mjs + source audit + run): transcodeJpeg + decodeToRgba8 does NOT bake EXIF rotation (lossless JPEG re-container + stored-layout decode; "source" pixels for orient!=1 => sideways render). Added exifr.orientation read + map (1/absent => "baked", else "source") in decodeMaster (proxy jpg), computeIngestPlan jpg branch, buildFallback tier3 jpg branch. Override ladder return obj (plain data) to plumb without editing ladder.ts. Manifest gets correct flag. "Ladder returns orientation" + full sig change deferred (request approval, coordinate Agent 4 / L9). Positive (BUG, user-visible): upright jpgs now "baked"; non-1 get explicit "source".
*   **F7 (deferred, not implemented):** fullLossless?:boolean (dist0 full), ML size hints in manifest (224/..), colorSpace:"srgb" tag. Per handoff: "note-only — do not implement without approval". Recorded; no code. (No silent drop.)

No items rejected. Changes limited to ingest.ts (helpers, decodeMaster, computeIngestPlan, buildFallbackPlan, ingestImage, batch accum, interfaces). Tests (ingest.test.ts + manifest + ladder) all pass post-edit. No schema changes (used metadata record + post-build attach). 

(Hand-off outcome per query: F1-6 implemented, F7 deferred; positive contributions accepted and landed.)
