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
*   **Throw on both distance+quality provided (Grok-ES-3):** REJECTED. Breaking behavioral change to existing callers. Current silent-precedence (distance wins) is explicit logic, not ambiguity. Requires a spec and explicit user decision.
*   **state / totalBytes read-only getters (Grok-ES-4):** REJECTED. New public API surface with no current consumer. YAGNI.
*   **pushPixels fast path via !acquirePromise (Grok-ES-5):** REJECTED. `acquirePromise` is assigned in the constructor and is always a `Promise<unknown>` — never `null` or `undefined`. `if (!this.acquirePromise)` is always `false`; the proposed fast path never executes. Logic bug. Also speculative; no profiling evidence that `acquirePromise` resolution is hot.
*   **dispose() method (Grok-ES-6):** REJECTED. Matches already-rejected DH-10 ("Explicit dispose() method: Ambiguous. `onCancel()` and `finally` blocks already handle full teardown."). `terminate()` via `cancel()` or abort covers all teardown paths.
*   **JSDoc class comment + richer error context (Grok-ES-7):** REJECTED. CLAUDE.md: comments only when WHY would surprise a reader. `@see EncodeSession` adds nothing beyond the class declaration. Commented-out `this.scheduler.removeMessageListener(this.id)` is code-smell; `onMessage` returns `void` with no unsubscribe API.
