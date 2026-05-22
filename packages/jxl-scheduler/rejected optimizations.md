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

---

# Rejected Optimizations — facade.ts (jxl-wasm)

Evaluated against `packages/jxl-wasm/src/facade.ts`. Two rounds of external suggestions; decisions recorded below.

## Round 1 (Grok batch)

### R1-1. `onDrain` callback on `JxlDecoder` interface
`scheduler.ts:309` (`waitForDrain`) + `decode-handler.ts:148` (`worker_drain` message) already implement full backpressure at the scheduler/worker boundary. The facade runs inside the worker; adding `onDrain` to `JxlDecoder` would duplicate this at the wrong layer and push scheduler concerns into the WASM bridge.

### R1-2. Shared pixel buffer pool in `applyRegionAndDownsample` / `readBuffer`
Output pixel buffers are caller-owned after yield. In the worker path `decode-handler.ts:188` transfers them via `postMessage(msg, [pixels])`, zeroing the reference — they cannot be recycled. In direct facade use, the caller holds an arbitrary-lifetime reference. No release lifecycle exists. The WASM input buffer (`chunkBufPtr`/`chunkBufCap`) is already reused across chunks in `eventsProgressive`.

### R1-3. `decodeLowResFirst` option
`DecoderOptions.downsample: 1|2|4|8` and `progressionTarget: "dc"` already exist. The caller uses `downsample: 8` + `progressionTarget: "dc"` for a fast preview, then a new session for the region of interest. No facade change needed.

### R1-4. `decodeBatch()` on facade
The scheduler + session layer is the batch API (`acquireSlot` with priority, sourceKey dedupe, AbortSignal). Duplicating batch logic in the facade would bypass preemption, dedupe, and backpressure entirely. Wrong layer.

### R1-5. Direct WASM write in `eventsOneShot` — IMPLEMENTED
`eventsOneShot` now writes chunks directly into a `_malloc`'d WASM heap buffer. `callDecode` (took a `Uint8Array`, did its own malloc) replaced by `callDecodeFromPtr` (takes pre-allocated ptr). `concatBytes` removed. Handle free consolidated into a single `try/finally`.

### R1-6. Sidecar + progressive preview strategy
Already implemented: `EncoderOptions.sidecarSizes`, `_jxl_wasm_encode_rgba8_with_sidecars`, chain traversal with `_jxl_wasm_buffer_next`, sidecars yielded smallest-first.

### R1-7. Adaptive quality / distance based on connection speed
Application logic. `EncoderOptions.distance` and `effort` are already first-class params. The facade has no access to network state and should not acquire it.

### R1-8. Worker-side header caching
`DedupeRegistry` in `scheduler.ts` fans out to existing sessions on matching `sourceKey`, avoiding re-parse. Caching decoded header state across session lifetimes would require stateful workers, breaking the stateless model and making `recycle()` unsafe.

### R1-9. `ReadableStream` / `WritableStream` API on `JxlDecoder` / `JxlEncoder`
Facade runs inside the worker; zero-copy transfer is already handled by `decode-handler.ts:188` (`postMessage(msg, [pixels])`). `ReadableStream` would be a thin API wrapper for direct (non-worker) use only — useful ergonomics, but not a performance improvement. Separate utility if desired.

### R1-10. Error recovery + partial decode resume from byte offset
JXL C API has no seek or resume-from-container-position function. Not implementable without a new C++ bridge.

## Round 2 (Grok batch)

### R2-1. Streaming `EncodeEvent` from `chunks()` (done/error events in the async iterable)
Changes `chunks()` return type from `AsyncIterable<ArrayBuffer | Uint8Array>` to a discriminated union — a breaking API change. `getStats()` already covers this: populated after the iterable completes normally, null on error, without forcing callers to discriminate event types in the hot receive path.
`ratio` field added to `EncodeStats` as a convenience (trivially derived but worth having in one place).

### R2-2. Shared pixel buffer pool (round 2)
Same rejection as R1-2. No safe ownership model without an explicit `release()` call that no current consumer implements.

### R2-3. `setBackpressureHandler` on `JxlDecoder`
Same rejection as R1-1. Scheduler/worker layer already handles this. The async iterator provides implicit pull-based backpressure for direct facade use.

### R2-4. `refineRegion()` on `JxlDecoder`
Would require caching the entire compressed input after decode completes (the chunk queue is drained and cleared). Increased memory for all decoders to support a minority use case. Application concern: caller creates a new session with a tighter `region` + lower `downsample`.

### R2-5. `createDecoderStream()` (WritableStream + ReadableStream wrapper)
Thin wrapper with no performance impact. Not a facade improvement. If wanted, belongs in a separate utilities export so it can be tree-shaken.

### R2-6. Memory-aware `eventsOneShot` (avoid `concatBytes`)
**Already implemented in Round 1** (R1-5 above). Grok did not have knowledge of the prior change.

### R2-7. Adaptive effort based on WASM tier — IMPLEMENTED
`recommendedEffort()` exported from `facade.ts`. Maps `scalar→4`, `simd→6`, `simd-mt|relaxed-simd-mt→7`. Non-breaking; callers opt in by passing `recommendedEffort()` as the `effort` field.

---

# Rejected / False Bottleneck Claims — bridge.cpp + facade.ts + browser.ts

Evaluated against `packages/jxl-wasm/src/bridge.cpp`, `packages/jxl-wasm/src/facade.ts`, and `packages/jxl-stream/src/browser.ts`.

## B-1. "Redundant Copy in bridge.cpp" — CLAIM FALSE, NO FIX NEEDED

Claim: "libjxl fills its own buffer and the bridge memcpys between them."

Reality: `DecodeRgba` (`bridge.cpp:182–191`) allocates `pixels_raw` via `malloc`, then calls `JxlDecoderSetImageOutBuffer(dec, &pf, pixels_raw, pixels_size)` — libjxl writes directly into our buffer. No intermediate copy. Result returned via `MakeBufferFromOwned` which transfers pointer ownership without copying (`bridge.cpp:79–89`). The progressive decoder follows the same pattern: `JxlDecoderSetImageOutBuffer` → direct write → `MakeBufferFromOwned` on `take_flushed`/`take_final`. `MakeBuffer` (which does an inline memcpy) is only used for 256 KB encoder output slices in `jxl_wasm_enc_take_chunk` — that's unavoidable chunking, not an image-sized copy.

## B-2. "Defensive Slicing in facade.ts" — CLAIM FALSE, NO FIX NEEDED

Claim: "The TS wrapper often copies the Uint8Array before passing it to WASM."

Reality: `LibjxlDecoder.push()` (`facade.ts`) branches on input type: `ArrayBuffer` → `new Uint8Array(chunk)` (zero-copy view); `Uint8Array` → slices only when `copyInput !== false`. The primary production path (`decode-handler.ts`) sends `ArrayBuffer` chunks via `postMessage` transfer — these are transferred (not shared), so the wrapper wraps them with zero copy. The `copyInput: false` opt-out already exists for callers that own their `Uint8Array` buffers. Inverting the default to "no-copy unless explicitly requested" would be a breaking change with no production benefit since the hot path never hits the slice.

## B-3. "Wait-and-Read Loop in browser.ts" — CLAIM TRUE, FIXED

Claim: "strict read→push→wait cycle prevents I/O prefetch from overlapping with push dispatch."

Reality confirmed. Original loop awaited `reader.read()` only after `session.push()` resolved, serializing network I/O with scheduler backpressure. For network-streamed inputs, `session.push()` can block at the adaptive HWM; during that block the next network chunk wasn't even being fetched.

Fix (`packages/jxl-stream/src/browser.ts`): prefetch pattern — start `pending = reader.read()` for chunk N+1 immediately after chunk N arrives (before `await session.push(N)`). The scheduler's backpressure still governs how many chunks the worker can buffer; the fix only pipelines the I/O prefetch with the push round-trip, masking network latency during backpressure wait.
