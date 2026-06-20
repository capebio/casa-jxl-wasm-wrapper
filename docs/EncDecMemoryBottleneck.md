# Enc/Dec Memory Bottleneck Audit

**Date:** 2026-06-20  
**Scope:** Full encode + decode pipeline — JS worker layer, WASM facade, C++ bridge, Rust RAW pipeline, cache, stream, scheduler.  
**Method:** Static analysis across 4 parallel sweeps (decode, encode, Rust/WASM, cache/stream/scheduler).

---

## Numbering

Issues are numbered M1–M13 (optimizable) and U1–U12 (fixed constraints).  
The synthesis table at the end cross-references all 25 items.

---

## Section 1 — CAN Be Optimized

### M1 · Decode input batch HEAPU8.set
**File:** `packages/jxl-wasm/src/facade.ts:1584`  
**Category:** copy  
**Size:** 64 KB – 1 MB per push batch (streaming) or up to 128 MB single-shot  
**Current:** Each incoming chunk is copied into WASM linear memory via `HEAPU8.set(chunk, chunkBufPtr + woff)`. For streaming decodes every chunk pays the full copy.  
**Fix:** Pre-allocate `chunkBufPtr` once via `expectedBytes` option to eliminate the grow-copy cycle. For known-size inputs (e.g. cache hits) pass `expectedBytes = fileSize` at decoder creation; the grow path (facade.ts:1569–1575) is skipped entirely. For unknown-size streams the realloc is unavoidable but amortises to O(log n).  
**Blocked by:** Nothing — `expectedBytes` is already wired; callers must supply it.

---

### M2 · toTransferablePixels slice on non-zero byteOffset
**File:** `packages/jxl-worker-browser/src/decode-handler.ts:724`  
**Category:** copy  
**Size:** 4–33 MB per frame (full frame at 4K RGBA8 = 33 MB)  
**Current:** When the typed-array view has `byteOffset ≠ 0` or `byteLength < buffer.byteLength`, a `.slice()` materialises a copy before transfer. This fires for any region/crop decode.  
**Fix:** Ensure the decoder always returns whole-buffer views — i.e. the bridge allocates a fresh buffer whose length equals the view length. Validate in tests with an assertion `buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength`. Where that invariant holds, the slice branch is dead code and can be removed.  
**Blocked by:** WASM decoder must guarantee aligned output (bridge.cpp:2228–2262 does this for full-frame; verify region path).

---

### M3 · Progressive pass pixel copy in takeAndWrap
**File:** `packages/jxl-wasm/src/facade.ts:1519`  
**Category:** copy  
**Size:** 1–33 MB × N passes (DC + each AC pass; 10-pass decode = 10 copies)  
**Current:** `new Uint8Array(buf.data)` copies pixels on every progress event when a region/downsample is applied. The borrow view (`retainBufferView`) is only valid in the same tick, so the worker copies defensively.  
**Fix:** Add a `copyOnProgress` flag (default `true`). When `false`, the session layer must consume the frame synchronously (no `await` between receive and use). Flag defaults keep existing callers safe; high-throughput tile decoders can opt into zero-copy.  
**Blocked by:** Caller discipline — zero-copy progress requires synchronous frame consumption.

---

### M4 · Region decode missing from progressive path
**File:** `packages/jxl-wasm/src/facade.ts` (implicit; bridge exists at `bridge.cpp:_jxl_wasm_decode_rgba8_region`)  
**Category:** alloc  
**Size:** Savings = (full frame − ROI) × pixelStride. For a 256×256 tile from a 4K image: saves ~32.8 MB per pass.  
**Current:** Progressive decoder always decodes the full frame; JS trims to ROI via `subarray()`. The full-frame pixel buffer is allocated and filled regardless of ROI size.  
**Fix:** Thread region coordinates through `eventsProgressive()` to the existing `_jxl_wasm_decode_rgba8_region` bridge, which already implements the C++ side. One-shot decode path already uses it; progressive does not.  
**Blocked by:** API surface — `eventsProgressive()` needs a `region?` parameter.

---

### M5 · Encode output chunk HEAPU8.slice
**File:** `packages/jxl-wasm/src/facade.ts:2613`  
**Category:** copy  
**Size:** 256 KB per chunk (configurable; `static const CHUNK = 262144` in bridge.cpp:2913)  
**Current:** Each output chunk is materialised via `module.HEAPU8.slice(ptr, ptr+len)` — a copy — because the borrowed view into `s->outbuf` would dangle after `enc_free()`. Chunks are yielded asynchronously, past the point where the WASM buffer is still live.  
**Fix:** Hold `enc_free()` until the async chunk iterator is exhausted. Gate cleanup on an RAII guard or a `finally` block in the chunk generator. With the buffer still live, use `module.HEAPU8.subarray(ptr, ptr+len)` (zero-copy borrow) and copy only when the caller has consumed the chunk. Saves 256 KB × (output_size / 256 KB) copies.  
**Blocked by:** Requires restructuring chunk generator to hold WASM encoder alive across the async yield boundary.

---

### M6 · toArrayBuffer slice in encode-handler
**File:** `packages/jxl-worker-browser/src/encode-handler.ts:498`  
**Category:** copy  
**Size:** 256 KB per chunk (same CHUNK constant)  
**Current:** `toArrayBuffer` (line 498–502) slices chunks when `byteOffset ≠ 0` or partial length, adding a copy before postMessage transfer.  
**Fix:** If M5 is implemented (facade yields aligned ArrayBuffers), this branch never fires. Alternatively, in the facade ensure all chunks from `enc_take_chunk()` are zero-byteOffset Uint8Arrays backed by a fresh ArrayBuffer — then `.buffer` can be transferred directly without `.slice()`.  
**Blocked by:** Depends on M5 (facade chunk alignment guarantee).

---

### M7 · Encode session toTransferableBuffer slice on misaligned chunks
**File:** `packages/jxl-session/src/util.ts:35`  
**Category:** copy  
**Size:** Up to full chunk size (varies; typically 64 KB–1 MB)  
**Current:** `chunk.buffer.slice()` fires when the input Uint8Array has a non-zero byteOffset (partial view of a larger ArrayBuffer). The entire underlying ArrayBuffer cannot be transferred; a slice is the only safe path.  
**Fix:** Require callers to supply `ArrayBuffer`-aligned chunks — e.g. convert `new Uint8Array(sharedBuf, offset, len)` to `sharedBuf.slice(offset, offset+len)` before calling `session.push()`. Document in the session API. Zero-byteOffset chunks skip the branch and transfer without copy.  
**Blocked by:** Caller convention. The fix is in the application layer, not the session layer.

---

### M8 · LookRenderer.render() clone per render call
**File:** `src/lib.rs:1804`  
**Category:** vec-alloc  
**Size:** ~6.5 MB (lightbox 1800×1200 RGB16, 3 u16/px)  
**Current:** `let mut rgb16 = self.rgb16.clone()` allocates on every render when `texture != 0.0 || clarity != 0.0` (i.e. any slider interaction). The comment at line 1636 notes the cache is immutable; the clone is needed for in-place sharpening.  
**Fix:** Thread-local scratch buffer (`std::cell::RefCell<Vec<u16>>`). On render, grow-to-fit once, then `copy_from_slice` the source. Eliminates `clone()` + `Vec::new()` — amortises to one allocation for the session lifetime. Saves ~6.5 MB per slider drag event on a lightbox image.  
**Blocked by:** Not blocked. Rust thread-local is safe in WASM single-thread context (Atomics disabled on main thread).

---

### M9 · Encoder metadata double-copy JS→WASM→C++
**File:** `packages/jxl-wasm/src/facade.ts:2286–2311` + `packages/jxl-wasm/src/bridge.cpp:3147,3153,3159`  
**Category:** copy  
**Size:** ICC (0–500 KB) + EXIF (0–50 KB) + XMP (0–100 KB) ≈ up to ~650 KB  
**Current:** Metadata is copied twice: (1) JS `Uint8Array` → WASM heap via `HEAPU8.set` in facade, (2) WASM heap → `enc_icc/enc_exif/enc_xmp` C++ buffers via `memcpy` in `jxl_wasm_enc_set_metadata`. Two copies, two allocations.  
**Fix:** Pass pointer + size directly from JS to C++ for single-shot encodes (borrow without intermediate WASM alloc). Requires C++ side to consume immediately (no deferred use across push() calls). For multi-frame encodes the owned copy is still required. Gate the borrow path on `singleFrameEncode` flag already present in bridge.  
**Blocked by:** Partial — multi-frame encodes still need ownership. Safe only for single-frame path.

---

### M10 · Paused decoder heap pinning without maxParkedSessions cap
**File:** `packages/jxl-scheduler/src/scheduler.ts:193`  
**Category:** metadata + pinned heap  
**Size:** ~20–50 MB per paused session (full WASM decoder heap remains live in the worker)  
**Current:** `workerPausedSession` map tracks paused decoders. Each paused session pins the entire worker WASM heap (including output pixel buffer). `maxParkedSessions` defaults to `Infinity` (line 206), meaning unbounded memory can be pinned by preemption.  
**Fix:** Set `maxParkedSessions = 2` (or 3 at most) in production. When exceeded, the scheduler evicts the oldest paused session (already implemented at lines 966–979 in the eviction path). Document the recommended value in the scheduler API. The code is correct; only the default is dangerous.  
**Blocked by:** Configuration — not a code change.

---

### M11 · Unbounded bufferedChunks on queued sessions
**File:** `packages/jxl-scheduler/src/scheduler.ts:97`  
**Category:** buffer  
**Size:** N chunks × ~64 KB each = potentially multi-MB per queued session  
**Current:** While a session waits in queue for a worker, incoming `send()` calls accumulate chunks in `bufferedChunks` array. No hard cap exists. If the caller ignores `waitForDrain()` signals, chunks stack up unbounded.  
**Fix:** Add a soft cap on `bufferedChunks.length` (e.g. 128 chunks per session = ~8 MB at 64 KB chunks). Exceeding it throws a `BackpressureExceeded` error so callers are forced to respect `waitForDrain()`. The backpressure system already handles normal usage; the cap is a safety rail against misbehaving callers.  
**Blocked by:** API change — callers must handle the new error.

---

### M12 · Encode buffered-path chunk accumulation before WASM copy
**File:** `packages/jxl-wasm/src/facade.ts:2201`  
**Category:** heap + copy  
**Size:** All pixel chunks held in `pixelChunks: Uint8Array[]` until `chunks()` call drains them in one pass  
**Current:** When streaming input is unavailable (sidecars or metadata active), chunks accumulate in a JS array then copied all-at-once to WASM at line 2203. Memory holds both the JS-side chunks and the WASM-side buffer simultaneously during the copy window.  
**Fix:** Switch this path to streaming-into-WASM even when sidecars/metadata are present — pass metadata first, then stream pixels in. Removes the double-resident window. This requires streaming the metadata before pixels, which is already the libjxl encode call order (metadata before `JxlEncoderAddImageFrame`).  
**Blocked by:** Requires verifying libjxl accepts metadata+pixel interleave in streaming encode mode.

---

### M13 · LookRenderer unpack at construction time
**File:** `src/lib.rs:541` (called from `src/lib.rs:1703`)  
**Category:** vec-alloc  
**Size:** ~3.6 MB for 1800×1200 lightbox (6B/px packed → 3 u16/px unpacked)  
**Current:** `LookRenderer::new()` immediately unpacks the packed 6B/px RGB16 bytes into a `Vec<u16>` via `unpack_rgb16_le()`. This Vec lives alongside the packed source bytes for the renderer's lifetime.  
**Fix:** Store only the packed bytes; unpack lazily on first `render()` call and cache the result. Saves the ~3.6 MB allocation for renderer instances that are created but never rendered (e.g. background preloads that are later evicted).  
**Blocked by:** Requires `OnceCell<Vec<u16>>` on LookRenderer struct.

---

## Section 2 — CANNOT Be Optimized

### U1 · Pixel output buffer first-frame allocation
**File:** `packages/jxl-wasm/src/bridge.cpp:2228`  
**Category:** alloc  
**Size:** `width × height × pixelStride` (e.g. 4K RGBA8 = 33 MB; 20 MP RGBA16 = 160 MB)  
**Constraint:** libjxl API (`JxlDecoderSetImageOutBuffer`) requires a pre-allocated output buffer before any pixels can be decoded. The buffer size is only known after the JXL header is parsed. No alternative — cannot pass NULL and resize.  
**Why fixed:** Decoder outputs pixels in-place; allocation is single-pass and reused for all progressive frames.

---

### U2 · Worker-to-main-thread pixel transfer (postMessage)
**File:** `packages/jxl-worker-browser/src/decode-handler.ts:521`  
**Category:** transfer  
**Size:** 4–33 MB per frame  
**Constraint:** Web Worker API. `postMessage` with a transfer list detaches the `ArrayBuffer` in the sender and moves ownership to the receiver. This is already the optimal path (zero-copy ownership transfer). No further optimisation is possible within the Web Worker API.  
**Why fixed:** Alternatives (SAB shared memory) are handled separately (decode-handler.ts:718 — already zero-copy when SAB available).

---

### U3 · Encode streaming HEAPU8.set at WASM boundary
**File:** `packages/jxl-wasm/src/facade.ts:1988`  
**Category:** copy  
**Size:** Full pixel data per image  
**Constraint:** WASM linear memory. JavaScript `TypedArray` views do not have stable addresses in WASM address space; the data must be copied into `HEAPU8` before C++ can read it. `SharedArrayBuffer` cannot be used for encoder input in threaded builds (synchronisation constraints).  
**Why fixed:** WASM FFI is a hard architectural boundary; no JS-originated pointer can cross it without a copy.

---

### U4 · Encode streaming pixel buffer pre-allocation
**File:** `packages/jxl-wasm/src/bridge.cpp:2953`  
**Category:** alloc  
**Size:** `width × height × channels × bytesPerChannel` (e.g. 4K RGBA8 = 67 MB)  
**Constraint:** Required by the streaming input design. The buffer is pre-allocated at encoder creation (full image dims are known from the encode spec); without it, JS-side accumulation would be required (worse for GC pressure). The allocation is single-pass for the encoder lifetime.  
**Why fixed:** Streaming encode requires a stable write target in WASM heap.

---

### U5 · OPFS full-file read materialisation
**File:** `packages/jxl-cache/src/browser.ts:288`  
**Category:** buffer  
**Size:** Full cached file (varies; typically 1–50 MB per JXL file)  
**Constraint:** The OPFS `File` API only exposes `file.arrayBuffer()` — full materialisation. Streaming OPFS reads require `FileSystemSyncAccessHandle.read()` which is worker-only and sync. The browser cache layer runs in an async context on the main thread; sync handles are not available.  
**Why fixed:** Web API limitation. OPFS streaming is blocked on browser support for async sync-handle reads.

---

### U6 · HTTP 200 fallback byte skip in stream layer
**File:** `packages/jxl-stream/src/browser.ts:622`  
**Category:** buffer  
**Size:** Up to `start` bytes skipped (e.g. 10 MB for a tile from a full response)  
**Constraint:** When a server ignores a `Range:` request and returns HTTP 200, the client must read and discard the prefix bytes. This is a zero-copy skip (`subarray()` + discard) — no buffer is accumulated. Cost is I/O, not memory. Cannot reduce without server cooperation.  
**Why fixed:** HTTP spec. The skip is already zero-copy; no memory optimisation is possible.

---

### U7 · MakeBuffer memcpy for decode result
**File:** `packages/jxl-wasm/src/bridge.cpp:167`  
**Category:** ffi-transfer  
**Size:** Full decoded output (12–40 MB)  
**Constraint:** `MakeBuffer` copies data from libjxl's internal output into a heap-allocated `JxlWasmBuffer` that JS can read. This copy is required: libjxl owns its internal output buffer and frees it on the next decoder call. The data must be copied out before proceeding.  
**Why fixed:** libjxl ownership model. Streaming path (lines 59–100) uses `MakeBufferFromOwned` (zero-copy) for static results where libjxl transfers ownership.

---

### U8 · ButteraugliInterface Image3F allocation
**File:** `packages/jxl-wasm/src/bridge.cpp:3510`  
**Category:** ffi-transfer  
**Size:** `3 × width × height × 4 bytes` (48–160 MB at 20 MP)  
**Constraint:** libjxl's Butteraugli computes in its own `Image3F` memory manager (SIMD-aligned plane layout). The reference image must be materialised in libjxl's format. No external buffer can be passed as a substitute.  
**Why fixed:** libjxl internal API; no hook to inject external memory.

---

### U9 · Demosaic SoA plane allocations
**File:** `crates/raw-pipeline/src/demosaic.rs:312`  
**Category:** vec-alloc  
**Size:** 3 × `width × height` u16 = 24–80 MB  
**Constraint:** Structure-of-Arrays (SoA) layout (`(r, g, b)` planes) is required for SIMD efficiency in the tone pipeline. Three separate plane allocations are the minimum. Callers on hot paths use `demosaic_rggb_planar_into()` (the preallocated variant); the allocating variant is only for callers that don't have a buffer ready.  
**Why fixed:** SIMD architecture requirement; the allocating variant is the fallback path. Critical callers (`src/lib.rs:666–672`) already use `_into`.

---

### U10 · PerceptualComparer scratch buffers
**File:** `crates/raw-pipeline/src/perceptual/mod.rs:166`  
**Category:** vec-alloc  
**Size:** 6 × `width × height` f32 (48–160 MB at 20 MP)  
**Constraint:** Scratch buffers (`tx, ty, tb, dx, dy, db`) are allocated once at `Comparer` construction and reused across all `all()`, `butteraugli()`, and `ssim()` calls. JS writes directly to the WASM heap via `input_ptr()` (zero-copy input). This is already the optimal pattern — one allocation, N reuses.  
**Why fixed:** Already optimised. Single-alloc scratch reuse is the floor.

---

### U11 · Tone processing stack scratch (PIPE-005)
**File:** `crates/raw-pipeline/src/pipeline.rs:1686`  
**Category:** stack (not heap)  
**Size:** 3 × 2048 f32 = 24 KB (stack-resident per function frame)  
**Constraint:** `let mut r = [0f32; BLK]` arrays are stack-allocated and hoisted once per `process_into` call, reused across all blocks. This is the PIPE-005 optimisation; no heap allocation occurs in the inner loop.  
**Why fixed:** Already on the stack; no heap involved.

---

### U12 · Prefetch lookahead in stream layer
**File:** `packages/jxl-stream/src/browser.ts:84`  
**Category:** buffer  
**Size:** One chunk in-flight (~64 KB)  
**Constraint:** One-chunk prefetch hides I/O latency by issuing the next read while the current chunk is being pushed to the decoder. The prefetch holds exactly one chunk reference (no accumulation). This is already the minimum viable lookahead.  
**Why fixed:** Zero-copy lookahead. Only one chunk lives in the prefetch at a time; removing it would leave the decoder starved waiting for I/O.

---

## Synthesis Table

| ID | Layer | File | Start Line | Category | Current State | Potential State |
|----|-------|------|------------|----------|---------------|-----------------|
| **M1** | Decode / WASM | `jxl-wasm/src/facade.ts` | 1584 | copy | 64 KB–128 MB copied per push batch | Eliminate grow-copy cycle via `expectedBytes` pre-alloc; known-size inputs pay 0 reallocations |
| **M2** | Decode / Worker | `jxl-worker-browser/src/decode-handler.ts` | 724 | copy | 4–33 MB copied per frame when view has byteOffset≠0 | Zero-copy transfer — guarantee full-buffer views from bridge; slice branch unreachable |
| **M3** | Decode / WASM | `jxl-wasm/src/facade.ts` | 1519 | copy | 1–33 MB copied per progressive pass (N passes = N×copies) | Optional zero-copy via `copyOnProgress: false`; synchronous consumers pay 0 copies |
| **M4** | Decode / WASM | `jxl-wasm/src/facade.ts` | (implicit; bridge at bridge.cpp) | alloc | Full frame decoded + allocated even for tiny ROI | Only ROI allocated; 4K→256px tile saves ~32.8 MB per pass |
| **M5** | Encode / WASM | `jxl-wasm/src/facade.ts` | 2613 | copy | 256 KB copied per output chunk (N chunks = N copies) | Zero-copy subarray borrow; defer `enc_free()` until iterator exhausted |
| **M6** | Encode / Worker | `jxl-worker-browser/src/encode-handler.ts` | 498 | copy | 256 KB copied per chunk when byteOffset≠0 | Zero-copy if M5 guarantees aligned ArrayBuffers from facade |
| **M7** | Encode / Session | `jxl-session/src/util.ts` | 35 | copy | Full chunk copied when input is a partial typed-array view | Zero-copy transfer — callers supply ArrayBuffer-aligned input |
| **M8** | Rust / RAW | `src/lib.rs` | 1804 | vec-alloc | ~6.5 MB cloned per render (every slider drag event) | Thread-local scratch pool; amortised to 1 alloc + 1 `copy_from_slice` for session lifetime |
| **M9** | Encode / Bridge | `jxl-wasm/src/facade.ts` + `bridge.cpp` | 2286 + 3147 | copy | ICC/EXIF/XMP copied twice: JS→WASM heap + WASM→C++ buffer (up to 650 KB × 2) | Single copy for single-frame encodes via pointer-borrow path |
| **M10** | Scheduler | `jxl-scheduler/src/scheduler.ts` | 193 | pinned heap | Unlimited paused decoders each pin 20–50 MB WASM heap (default: Infinity) | Set `maxParkedSessions = 2`; bounded to 40–100 MB max pinned |
| **M11** | Scheduler | `jxl-scheduler/src/scheduler.ts` | 97 | buffer | Chunks accumulate unbounded if caller ignores `waitForDrain()` | Hard cap (128 chunks ≈ 8 MB); exceed throws, forces caller compliance |
| **M12** | Encode / WASM | `jxl-wasm/src/facade.ts` | 2201 | heap + copy | JS chunks + WASM buffer both live simultaneously during copy window | Stream pixels into WASM as they arrive; removes double-resident window |
| **M13** | Rust / RAW | `src/lib.rs` | 541 | vec-alloc | 3.6 MB unpacked on every `LookRenderer::new()` including non-rendered instances | Lazy unpack via `OnceCell`; unrendered renderers pay 0 extra allocation |
| **U1** | Decode / Bridge | `jxl-wasm/src/bridge.cpp` | 2228 | alloc | Full-frame pixel buffer allocated after header parse | **Fixed** — libjxl API requires pre-allocated output buffer |
| **U2** | Decode / Worker | `jxl-worker-browser/src/decode-handler.ts` | 521 | transfer | 4–33 MB transferred per frame (ownership move, zero-copy) | **Fixed** — Web Worker API; already optimal (transfer, not copy) |
| **U3** | Encode / WASM | `jxl-wasm/src/facade.ts` | 1988 | copy | Full pixel data copied into WASM linear memory | **Fixed** — WASM FFI hard boundary; JS pointers cannot cross |
| **U4** | Encode / Bridge | `jxl-wasm/src/bridge.cpp` | 2953 | alloc | Full-image pixel buffer pre-allocated at encoder creation | **Fixed** — required for streaming input design |
| **U5** | Cache | `jxl-cache/src/browser.ts` | 288 | buffer | Entire cached file materialised into ArrayBuffer on every read | **Fixed** — OPFS File API has no streaming read path |
| **U6** | Stream | `jxl-stream/src/browser.ts` | 622 | buffer | Prefix bytes skipped chunk-by-chunk (zero-copy, not buffered) | **Fixed** — HTTP spec; already zero-copy skip |
| **U7** | Decode / Bridge | `jxl-wasm/src/bridge.cpp` | 167 | ffi-transfer | Decoded output copied from libjxl internal buffer to JS-readable heap | **Fixed** — libjxl owns its buffer; must copy before next decode call |
| **U8** | Perceptual / Bridge | `jxl-wasm/src/bridge.cpp` | 3510 | ffi-transfer | 48–160 MB `Image3F` allocated in libjxl memory manager for Butteraugli | **Fixed** — libjxl internal API; no external memory injection |
| **U9** | Rust / RAW | `crates/raw-pipeline/src/demosaic.rs` | 312 | vec-alloc | 24–80 MB SoA planes allocated (fallback path only) | **Fixed** — SIMD requires SoA; hot callers use `_into` variant |
| **U10** | Rust / Perceptual | `crates/raw-pipeline/src/perceptual/mod.rs` | 166 | vec-alloc | 48–160 MB scratch; allocated once, reused across all comparisons | **Fixed** — already the optimal single-alloc reuse pattern |
| **U11** | Rust / Pipeline | `crates/raw-pipeline/src/pipeline.rs` | 1686 | stack | 24 KB per block on stack, hoisted once per `process_into` call | **Fixed** — stack, not heap; PIPE-005 already in place |
| **U12** | Stream | `jxl-stream/src/browser.ts` | 84 | buffer | One chunk in-flight (prefetch); zero accumulation | **Fixed** — minimum viable lookahead; already zero-copy |

---

## Priority

| Priority | ID | Impact | Effort |
|----------|----|--------|--------|
| High | M4 | –32 MB/pass for tile decode | Medium (thread region to progressive path) |
| High | M10 | Unbounded heap leak in production | Trivial (set one config value) |
| High | M2 | –33 MB/frame on every decode | Low (assert invariant, remove dead branch) |
| Medium | M5 | –N×256 KB per encode | Medium (restructure chunk generator) |
| Medium | M8 | –6.5 MB per render (slider drag path) | Low (thread-local scratch) |
| Medium | M1 | Eliminates realloc churn on known-size reads | Low (pass `expectedBytes` at call site) |
| Low | M3 | Optional zero-copy for synchronous consumers | Medium (flag + API change) |
| Low | M11 | Safety rail against misbehaving callers | Low (add length check + throw) |
| Low | M13 | –3.6 MB for non-rendered LookRenderer | Low (OnceCell) |
| Negligible | M6, M7, M9, M12 | Depends on M5 or niche code paths | Varies |
