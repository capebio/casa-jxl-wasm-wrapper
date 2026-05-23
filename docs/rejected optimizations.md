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

## 7. Soft preemption via yield message
Proposed: send `decode_yield_request` to the victim worker; if it responds with `decode_yielded` within 300ms, avoid a hard cancel.

Rejected for two reasons (a third reason, originally listed here, has since been resolved — see note below):

1. **No benefit at the natural yield point.** `DecodeHandler.feedDecoder` already exits cleanly at chunk boundaries: `onCancel` sets `this.cancelled` and wakes `wakeResolve`, so the loop terminates at its next iteration. Hard cancel is already "soft" when the decoder is between chunks.

2. **No benefit mid-push either.** When `decoder.push(chunk)` is actively running, WASM executes synchronously to completion — it cannot be interrupted. The 300ms grace window would simply time out and fall back to hard cancel, adding latency without saving anything.

Progress-aware victim scoring (implemented) is the correct lever: avoid preempting nearly-done sessions entirely rather than trying to preempt them gently.

**Note — full pause/resume is now implemented.** The original reason 3 claimed "pause and resume is not available" because "the decoder would need to serialise its internal state." This is no longer accurate. The implemented approach does not require state serialisation: the WASM decoder object lives in the worker's heap and is left alive while the worker services the high-priority session. The victim session is suspended in-place (`decode_pause` → `decode_paused` ack → worker continues on high-priority task), then resumed on the same worker (`decode_resume`) once that task completes. A `workerPausedSession` map in the scheduler tracks which worker holds a suspended session to ensure chunk routing and resume land on the correct worker. The `decode_yield_request` message design (this proposal) is still rejected — but the capability it was trying to achieve is covered by the structural pause/resume.

Affected files: `packages/jxl-core/src/protocol.ts`, `packages/jxl-scheduler/src/scheduler.ts`, `packages/jxl-worker-browser/src/decode-handler.ts`, `packages/jxl-worker-browser/src/worker.ts`, `packages/jxl-worker-node/src/decode-handler.ts`, `packages/jxl-worker-node/src/worker.ts`.

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

---

# Round 3 — facade.ts (20-item batch)

Evaluated against `packages/jxl-wasm/src/facade.ts` as of commit `b2b9c2d`.

## R3-1. Single-consumer guards on `events()` / `chunks()` — IMPLEMENTED

`eventsStarted` flag added to `LibjxlDecoder`; `chunksStarted` flag added to `LibjxlEncoder`. Second call to `events()` yields an `{ type: "error", code: "InvalidState" }` event and returns. Second call to `chunks()` throws synchronously (no error-event channel on that type). Both guards prevent zombie sessions from duplicate iteration.

## R3-2. Push-after-close guard + duplicate-close guard + `wake()` helper — IMPLEMENTED

`closed: boolean` added to `LibjxlDecoder`. `push()` and `close()` both early-return when `cancelled || closed`. `close()` sets `closed = true` before pushing the null sentinel — prevents multiple sentinels on repeated calls. Inline `wakeResolve?.(); wakeResolve = null` pattern replaced by `private wake()` method used in `push`, `close`, `cancel`, and `dispose`.

## R3-3. `DeferredVoid` class replacing single-slot wake — REJECTED

Single-slot invariant is structurally guaranteed: only one generator can consume the decoder (enforced by R3-1), and only `waitForQueueItem()` ever awaits, called sequentially within that generator. `DeferredVoid` adds a class + allocation per wait with no correctness gain. Reject.

## R3-4. Encoder incremental byte counter + early rejection — IMPLEMENTED

`queuedPixelBytes: number` added to `LibjxlEncoder`, incremented in `pushPixels()`. Early rejection throws if `queuedPixelBytes + incoming > pixelByteTotal`. `chunks()` uses `this.queuedPixelBytes` directly (no reduce scan). `pixelByteTotal` computed once in constructor via `expectedPixelBytes()`.

## R3-5. Progressive pixel chunk release during WASM copy — IMPLEMENTED

Copy loop in `chunks()` now sets `this.pixelChunks[i] = EMPTY_U8` immediately after each chunk is copied to WASM heap. The module-level `EMPTY_U8 = new Uint8Array(0)` constant avoids per-iteration allocation. Peak JS heap overlap (all input chunks + full WASM copy simultaneously alive) is reduced to one-chunk granularity.

## R3-6. Streaming input encoder (new bridge functions) — IMPLEMENTED (build pending)

Code complete across all three layers. `bridge.cpp`: `JxlWasmEncState` extended with `pixels_buf`/`size`/`written` and encode params; `jxl_wasm_enc_create_image`, `jxl_wasm_enc_push_chunk`, `jxl_wasm_enc_finish` added and exported; `jxl_wasm_enc_free` updated to free `pixels_buf`. `exports.txt`: three new exports. `facade.ts`: `LibjxlEncoder.pushPixels()` is now async; first push calls `ensureModule()` and initialises WASM state via `enc_create_image`; `chunks()` detects the streaming path and calls `enc_finish`/`enc_take_chunk`; `cancel()`/`dispose()` call `freeWasmState()` on abort; buffered path preserved as fallback for sidecars and old WASM builds.

Build blocked pending: (1) forward-declaration fix for `jxl_wasm_transcode_jpeg_to_jxl` in `bridge.cpp` line 575 (pre-existing, not caused by this change), (2) Docker registry auth for `ghcr.io/emscripten-core/emsdk` — switch primary to `docker.io/emscripten/emsdk` in `build.mjs:resolveEmsdkImages()`, then run `node scripts/build.mjs` from `packages/jxl-wasm`.

Affected files: `packages/jxl-wasm/src/bridge.cpp`, `packages/jxl-wasm/src/facade.ts`, `packages/jxl-wasm/exports.txt`.

## R3-7. Pooled WASM input buffer for transcode / one-shot decode — REJECTED

Module-level scratch buffer is unsafe with concurrent sessions sharing one module instance. Instance-owned version saves one `malloc`/`free` per decode — marginal vs. the decode cost itself. `eventsProgressive` already reuses `chunkBufPtr`/`chunkBufCap` across chunks, which is the hot allocation. `eventsOneShot` makes one large allocation per call — geometric growth buys nothing since each decode has a different total size. Reject.

## R3-8. `takeBuffer()` / `readBufferView()` ownership split — IMPLEMENTED

`readBuffer()` had mixed ownership: freed handle on error, left it to caller on success. The "Read next BEFORE readBuffer" comment in the sidecar chain was a footgun. Replaced with:
- `readBufferView()` — never frees; caller owns handle in all cases.
- `takeBuffer()` — frees in `finally`; use when caller wants to consume and discard.
- `callDecodeFromPtr()` now catches `readBufferView` failures and frees the handle itself before rethrowing — prevents leak when decode succeeds but buffer is malformed.
- All encode call sites (`chunks()` sidecar chain, streaming path, standard path, transcode) converted to `takeBuffer()`. Sidecar error path simplified — no more catch-free-rethrow boilerplate.

## R3-9. Overflow-safe pixel byte calculation — IMPLEMENTED

`bytesPerChannelForFormat(format)` helper added. `expectedPixelBytes(width, height, format)` validates integer dimensions, checks `Number.isSafeInteger`, and rejects allocations above 1 GiB. Used in `LibjxlEncoder` constructor (once) and replaces the inline multiply in `chunks()`.

## R3-10. Option normalisation into constructor — REJECTED

`fmtIndex`, `bpc`, `pixelStride`, `distance`, `hasAlpha` are cheap derivations from immutable options. Moving them to constructor requires new `NormalizedDecoderOptions` / `NormalizedEncoderOptions` interfaces, adding ~30 LOC for no runtime win measurable against WASM call overhead. CLAUDE.md: simplicity first, no speculative abstractions. Reject.

## R3-11. `distanceFromQuality()` exact formula — IMPLEMENTED

`(100 - quality) / 6.67` → `((100 - q) * 15) / 100`. Avoids floating-point rounding from the approximated denominator. Added `Number.isFinite` guard for non-finite inputs. Clamp applied before multiply.

## R3-12. `copyOrBorrowInput()` helper replacing inline ternaries — IMPLEMENTED

Replaces three identical copy-or-borrow ternaries in `push()`, `pushPixels()`, and `transcodeJpegToJxl()`. `ArrayBuffer` → zero-copy view; `Uint8Array` → slice or borrow depending on `copy` flag. `toUint8Array()` removed.

## R3-13. `pushBorrowed()` / `pushOwned()` per-call copy control — REJECTED

Per-call ownership control is a niche API extension. The `copyInput` constructor option covers production use cases. Adding optional interface methods for rare mixed-ownership callers bloats the public API without a concrete consumer. Reject.

## R3-14 + R3-15. Bounded input queue + async backpressure push — DEFERRED

`maxQueuedBytes` option and async push backpressure are valid for direct (non-worker) facade use. In the worker path, the scheduler's `waitForDrain` / adaptive HWM already throttles input at the session boundary — a second layer in the facade would be redundant. Deferring until a direct-use consumer exists that needs the limit. The interface already declares `push(): void | Promise<void>` so the async upgrade is non-breaking when needed.

## R3-16. Cap first progressive push to 64 KB for faster header — REJECTED

Adds `currentChunkOffset` partial-chunk tracking, significantly complicating `eventsProgressive`'s inner loop. In practice, callers push data as it arrives from the network/worker; large upfront queues before `events()` starts are not the common case. Header latency is better addressed at the caller level (start iterating `events()` before pushing bulk data). The throughput benefit of batching outweighs the latency cost in the steady state. Reject.

## R3-17. Downsample-only full-image fast path in `applyRegionAndDownsample()` — ALREADY HANDLED

The `stride === 4` branch (line 908 of original) already handles `region === null` + `downsample !== 1` for rgba8 — `sourceRegion` becomes `{x:0, y:0, w:width, h:height}` from `normalizeRegion`, so the loop address math is identical to the proposed specialisation. The only overhead avoided is the `normalizeRegion` call itself, which is trivial. No code change needed.

## R3-18. Avoid object spread in hot emitted events — IMPLEMENTED

`...(pixels.region === undefined ? {} : { region: pixels.region })` replaced with `const ev: Extract<DecodeEvent, {type: T}> = {...}; if (pixels.region !== undefined) ev.region = pixels.region;` across all yield sites in `eventsProgressive` and `eventsOneShot`. Eliminates one temporary object allocation per emitted pixel event.

## R3-19. Module capability detection cached once — IMPLEMENTED

`JxlCapabilities` interface + `capabilityCache: WeakMap<LibjxlWasmModule, JxlCapabilities>` + `getCapabilities(module)` function added. Covers `progressiveDecode`, `streamingEncode`, `sidecars`, `jpegTranscode`. `typeof module._xxx === "function"` checks in `events()`, `chunks()`, and `transcodeJpegToJxl()` replaced with single `getCapabilities(module)` call per operation.

## R3-20. Deterministic JS queue release in `events()` / `chunks()` finally — IMPLEMENTED

`events()` outer `try/catch` gains a `finally` block clearing `chunkQueue`, `readIndex`, `queuedBytes`. `chunks()` `finally` block clears `pixelChunks` and `queuedPixelBytes` as belt-and-suspenders after normal or error exit. On normal completion the queue is effectively drained already; on error or cancel this ensures prompt GC eligibility without waiting for caller to call `dispose()`.

---

## B-3. "Wait-and-Read Loop in browser.ts" — CLAIM TRUE, FIXED

Claim: "strict read→push→wait cycle prevents I/O prefetch from overlapping with push dispatch."

Reality confirmed. Original loop awaited `reader.read()` only after `session.push()` resolved, serializing network I/O with scheduler backpressure. For network-streamed inputs, `session.push()` can block at the adaptive HWM; during that block the next network chunk wasn't even being fetched.

Fix (`packages/jxl-stream/src/browser.ts`): prefetch pattern — start `pending = reader.read()` for chunk N+1 immediately after chunk N arrives (before `await session.push(N)`). The scheduler's backpressure still governs how many chunks the worker can buffer; the fix only pipelines the I/O prefetch with the push round-trip, masking network latency during backpressure wait.

---

# Round 4 — scheduler / facade / bridge (10-item batch)

Evaluated against `packages/jxl-scheduler/src/scheduler.ts`, `packages/jxl-scheduler/src/pool.ts`, `packages/jxl-wasm/src/facade.ts`, and `packages/jxl-worker-browser/src/decode-handler.ts`.

## R4-1. Pool Pre-warming — IMPLEMENTED

`prewarmSize?: number` added to `SchedulerOptions`. `WorkerPool.prewarm(count)` spawns workers eagerly at construction (fire-and-forget, respects `maxSize`). Workers start idle timers immediately so they are reaped normally if unused within `idleTimeoutMs`. Eliminates 100–200 ms first-image cold-start penalty.

Affected files: `packages/jxl-scheduler/src/pool.ts`, `packages/jxl-scheduler/src/scheduler.ts`.

## R4-2. Worker-side createImageBitmap — REJECTED

Proposal: call `createImageBitmap(new Blob([pixels], { type: "image/x-rgba8" }))` inside the decode worker; transfer `ImageBitmap` to main thread.

Rejected for three reasons:

1. **Invalid MIME type.** `"image/x-rgba8"` is not a registered image format; `Blob` + `createImageBitmap` expect encoded image data (PNG, JPEG, etc.), not raw RGBA pixel bytes. The proposal's code snippet would throw or produce a black bitmap.

2. **Breaks non-rgba8 paths.** The worker handles `rgba16` and `rgbaf32` (HDR) formats. `ImageData` (the correct raw-pixel path) only accepts `Uint8ClampedArray`, which cannot represent 16-bit or float precision. Inserting `createImageBitmap` here would silently corrupt scientific data.

3. **Wrong layer.** `decode-handler.ts` is browser/Node-agnostic at the protocol level. Adding a browser-only canvas API call ties it to the DOM. Consumer code already has the decoded `ArrayBuffer` and can call `createImageBitmap(new ImageData(new Uint8ClampedArray(pixels), w, h))` in one call on the main thread for rgba8 previews.

## R4-3. AsyncEventStream Promise Fast-Path — CLAIM FALSE, NO FIX NEEDED

Claim: every `next()` call allocates a new Promise.

Reality: `waitForQueueItem()` (`facade.ts`) already fast-paths: `if (this.chunkQueue.length > this.readIndex) return Promise.resolve()`. The surrounding loop in `eventsProgressive` only calls `waitForQueueItem` when no items are buffered (`if (this.chunkQueue.length <= this.readIndex)`), so the fast path is always taken when data is available.

## R4-4. Redundant Slicing for Transfers — CLAIM FALSE, NO FIX NEEDED

Claim: `toTransferableBuffer` causes redundant copies.

Reality: `toTransferableBuffer` does not exist in this codebase. `copyOrBorrowInput()` (`facade.ts`) already handles ownership: `ArrayBuffer` → zero-copy `new Uint8Array(ab)` view; `Uint8Array` → copies only when `copyInput !== false`, which callers opt out of via `copyInput: false`. The primary production path (transferred `ArrayBuffer` chunks from `postMessage`) never hits the copy branch. `SharedArrayBuffer` would require COOP/COEP headers and complicates ownership; not appropriate here.

## R4-5. WASM Heap 64 MB Initial Memory — CLAIM FALSE, ALREADY AT 64 MB

Claim: initial WASM memory should be raised from 32 MB to 64 MB.

Reality: `build.mjs` already sets `-sINITIAL_MEMORY=67108864` (64 MB) in both `baseFlags` (line 49) and `linkBridge` (line 229). The HANDOFF.md fast-relink recipe shows 33554432 (32 MB) but that is an illustrative manual snippet, not the production build path.

## R4-6. Synchronous Slot Booking — REJECTED

Proposal: reserve the slot synchronously, resolve the worker assignment later.

Rejected: `acquireSlot` is already O(1) for the common case — `pool.acquire()` returns in one microtask when an idle worker exists. The queue enqueue is synchronous. The async cost is one `pool.acquire()` check per session, not N ticks per N sessions. A fully synchronous booking path would bypass the preemption check and the dedupe lookup, both of which require async coordination. No profiling data shows this as a measurable bottleneck.

## R4-7. Encoder Pixel Chunk Aggregation — REJECTED

Proposal: buffer pixel pushes below a 256 KB threshold before sending to the worker.

Rejected: No evidence callers push sub-256 KB chunks. The streaming input path (R3-6) copies each chunk directly to the WASM pixel buffer at the moment it arrives — the worker-side cost per message is a single `HEAPU8.set`. Adding aggregation introduces a partial-buffer state that complicates `finish()` (must flush remainder), adds latency for callers that push one large chunk, and solves a problem for which no benchmark data exists.

## R4-8. UUID → Monotonic Counter — REJECTED

100 `crypto.randomUUID()` calls ≈ 100–300 µs total — below measurement noise for a gallery load. A counter wraps on integer overflow, collides across page reloads, and degrades log readability. The proposal's own impact rating is "Low." Not worth the churn.

## R4-9. Tier Detection Re-Probing — CLAIM FALSE, NO FIX NEEDED

Claim: `detectTier()` re-runs WASM probes on every call.

Reality: `_cachedDetectedTier` module-level variable (`facade.ts`) caches the result after the first call. `detectTier()` returns on the first line when `_cachedDetectedTier !== undefined`. The proposed `window.__JXL_TIER__` global would pollute the namespace and conflict with multiple module instances.

## R4-10. Single-Trip Metadata Pass — REJECTED

Claim: EXIF/XMP/ICC ArrayBuffers are transferred multiple times across threads.

Reality: metadata is set once in `EncoderOptions` and flows into the `LibjxlEncoder` constructor. There is no multi-hop routing — it does not travel Main → Scheduler → Worker → Bridge as the proposal suggests. The actual issue is that `bridge.cpp`'s `EncodeRgba()` ignores `iccProfile`, `exif`, and `xmp` entirely (HANDOFF.md §4 — wiring ICC/EXIF/XMP in the C++ bridge is the correct fix, not changing the JS routing).

---

# Round 5 — decode-handler.ts (10-item batch)

Evaluated against `packages/jxl-worker-browser/src/decode-handler.ts`.

## DH-1. Adaptive drain HWM + latencyMs in drain message — IMPLEMENTED

Static `CHUNK_HWM = 4` replaced by EMA-based `adaptiveHwm()`. Each `decoder.push(chunk)` call is timed; EMA (α = 0.25) tracks per-chunk WASM decode latency. `adaptiveHwm()` scales `HWM_BASE = 6` by `clamp(0.6, 2.0, 120 / (ema + 10))`, giving range [3, 12]. Fast workers push the HWM up (fewer drain round-trips); slow workers bring it down (earlier drain signal, less queued memory). Drain message gains optional `latencyMs` field, giving the scheduler real-time data to tune its own `pushHwm`. `MsgWorkerDrain` in `protocol.ts` updated with `latencyMs?: number`.

Affected files: `packages/jxl-worker-browser/src/decode-handler.ts`, `packages/jxl-core/src/protocol.ts`.

## DH-2. Pixel buffer pool for output transfers — REJECTED

Proposed module-level pool for pixel output `ArrayBuffer`s. `postMessage(msg, [pixels])` transfers the buffer, detaching it — it cannot be returned to any pool (the reference becomes a zero-length neutered buffer). Same rejection as R1-2 and R2-2 (facade.ts rounds 1 and 2). No safe ownership model without an explicit `release()` call that no current consumer implements.

## DH-3. Progress event throttling (50 ms) — REJECTED

Adds a `PROGRESS_THROTTLE_MS` gate to suppress intermediate `decode_progress` postMessages. Progressive frame delivery is a first-class UX feature; suppressing frames defeats it. For typical JXL images (DC + 1–3 refinement passes) throttling saves at most 2–3 messages per decode — not worth the complexity or the UX regression. No benchmark data showing inter-thread message rate is a bottleneck.

## DH-4. Improved compactQueue() — REJECTED

Proposed: extract inline compaction into a helper method; lower threshold from 64 to 32; add explicit null loop before `slice`. The current inline loop (line 179) already nulls each slot immediately on consumption (`this.chunkQueue[this.chunkReadIndex++] = undefined as any`), so the proposed null loop is redundant. Threshold 64 avoids needless `slice()` allocations in typical burst-feed patterns; lowering it increases array churn for no GC benefit.

## DH-5. Global + rolling-window budget — REJECTED

Proposed adding `globalStartMs` alongside `stageStartMs`. `stageStartMs` is set in the constructor (`performance.now()`) and never reset — `checkBudget()` already measures global elapsed time from session creation, not per-stage elapsed time. The field name is misleading but the measurement is correct. Adding a second timer duplicates the measurement.

## DH-6. Pixel dump on pause — REJECTED

Proposed: on `onPause()`, optionally send current partial pixels as a `"paused"` message for UI continuity. The most recent `decode_progress` message already delivered the last emitted partial frame to the main thread. Re-sending on pause is redundant and would require new facade API (a "dump current partial frame" method that the facade does not expose).

## DH-7. Metrics expansion (add stage/queueDepth) — REJECTED

`CodecMetric` is a closed discriminated union; adding `stage` or `queueDepth` requires modifying every variant or restructuring `MsgMetric`. Protocol churn for marginal debugging value that can be derived from existing timing metrics.

## DH-8. Error context enrichment (add stage + bytesProcessed) — REJECTED

Adding `stage` to `decode_error` requires a `MsgDecodeError` protocol change. The proposed `bytesProcessed` computation is also incorrect: the chunk queue slots are null'd on consumption, so `chunkQueue.reduce(...)` would return 0 for processed bytes and nonzero only for still-queued bytes — the opposite of the label.

## DH-9. Facade buffer pool integration — REJECTED

Same rejection as DH-2 and R1-2/R2-2. No safe ownership model for transferred buffers.

## DH-10. Explicit dispose() method — REJECTED

Proposed: add a `dispose()` separate from `onCancel()` for scheduler-driven cleanup. `onCancel()` already handles the full teardown: sets `cancelled`, unblocks `waitForResume`, transitions state, posts `decode_cancelled`, invokes `onSessionEnd`. `run()`'s `finally` block calls `decoder.dispose()`. Adding a second cleanup path creates ambiguity about which to call when.
