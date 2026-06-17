# JXL Buffer Lifecycle — Complete Map

## Decode Copy Map (Progressive, RGBA8, No Region, No Downsample)

| Step | Location | Copy? | Notes |
|------|----------|-------|-------|
| Main thread chunk | `DecodeSession` instance var | — | User pushes Uint8Array |
| `toTransferableBuffer` | `decode-session/util.ts` | **transfer** (zero-cost) | ArrayBuffer extracted, transferred to worker |
| `scheduler.send` | `scheduler.ts` | **transfer** | postMessage with transfer list |
| Worker receives | `Worker.onmessage` | — | Message event in worker context |
| Route to handler | `decode-handler.ts:onChunk` | — | Handler processes message |
| `ChunkRing` storage | `decode-handler.ts` queue | **zero-copy** | Stores ArrayBuffer reference |
| Batch accumulation | `facade.ts:eventsProgressive` loop | `queuedBytes` counter | Waits for HWM or flush |
| **HEAPU8.set** | `facade.ts ~line 1472-1483` | **COPY #1** (JS→WASM) | `module.HEAPU8.set(chunk, chunkBufPtr+woff)` per chunk in batch |
| `chunkBufPtr` buffer | WASM heap alloc | — | Grow-only, freed at session end |
| `decPush` call | `facade.ts` binding | — | Passes `(dec, ptr, bytes)` to libjxl C |
| WASM decode | libjxl internal | — | Progressive loop inside libjxl |
| Output handle | `decTakeFlushed` | — | Frame completed; WASM ready to yield pixels |
| **HEAPU8.subarray** | `facade.ts:retainBufferView` | **zero-copy VIEW** | `module.HEAPU8.subarray(outPtr, size)` — dangling ref |
| **new Uint8Array** | `facade.ts:takeAndWrap ~1416` | **COPY #2** (WASM→JS) | Deep copy into new backing (detach from heap) |
| `applyRegionAndDownsample` | `facade.ts` | O(W×H) if region set | JS cropping + downsampling (optional) |
| `applyTargetResize` | `facade.ts` | O(W×H) if dims mismatch | JS bilinear resize (optional) |
| **toTransferablePixels** | `facade.ts` | **zero-copy** (normal) or **COPY #2.5** (MT SAB) | If SAB: `.slice()` copy required; else as-is |
| `postMessage` | Worker → Main | **transfer** (zero-cost) | postMessage([pixels.buffer]) detaches |
| Main thread frame | `decode-session:handleMessage` | — | frameStream receives frame reference |

**Total: 2 copies + 1 optional SAB copy (MT only)**

---

## Encode Copy Map (Streaming Input Path)

| Step | Location | Copy? | Notes |
|------|----------|-------|-------|
| Main thread pixels | User app (canvas / Uint8ClampedArray) | — | Source data |
| `encode-session.pushPixels` | `encode-session.ts` | — | Queues internally |
| `toTransferableBuffer` | `util.ts` | **transfer** (zero-cost) | ArrayBuffer extracted, transferred to worker |
| `scheduler.send` | `scheduler.ts` | **transfer** | postMessage with transfer list |
| Worker receives | `Worker.onmessage` | — | Message event in worker context |
| Route to handler | `encode-handler.ts:onPixels` | — | Handler processes message |
| `pixelQueue` storage | `encode-handler.ts` | **zero-copy** | Stores ArrayBuffer chunk reference |
| Queue accumulation | Waits for feedEncoder | `queuedPixels` counter | Tracks bytes ready to encode |
| **enc_pixels_ptr** call | `facade.ts ~line 1857` | — | WASM FFI returns heap ptr for input |
| **HEAPU8.set** | `facade.ts ~line 1859` | **COPY #1** (JS→WASM) | `module.HEAPU8.set(view, ptr)` — push chunk to WASM |
| WASM encode | libjxl internal | — | Encoder processes input, produces frames |
| `enc_take_chunk` | `facade.ts` | — | WASM FFI returns next output chunk |
| **HEAPU8.slice** | `facade.ts` | **COPY #2** (WASM→JS) | `module.HEAPU8.slice(dataPtr, size)` — extract ≤256KB chunk |
| `toTransferableBuffer` | Post-take | **transfer** (zero-cost) | Wrap slice result as transferable |
| `postMessage` | Worker → Main | **transfer** (zero-cost) | postMessage([chunk.buffer]) detaches |
| Main thread chunk | `encode-session:handleMessage` | — | onData callback receives chunk |

**Total: 2 copies (both necessary: input encapsulation + output detach)**

---

## One-Shot Decode (Complete File)

Similar to progressive, but:
- Input: entire JXL file in one `_malloc(totalSize)` (line ~1344)
- `decPush` called once with full file
- Output: `readBufferView` uses `HEAPU8.slice` (vs `subarray+copy` in progressive)
- Overall: same 2 copies (input accumulate, output detach); freed in `finally`

---

## Buffered Encode (Metadata / Sidecars)

Similar to streaming, but:
- Input queued as Uint8Array chunks, then bulk `HEAPU8.set` (vs streaming `enc_pixels_ptr` per-push)
- Output: same chunk extraction
- Overall: same 2 copies

---

## Reference Path (Transfer vs Copy)

| Transfer Type | Detach | Zero-Cost | Notes |
|---------------|--------|-----------|-------|
| `ArrayBuffer.transfer()` (if supported) | ✓ | ✓ | Modern postMessage transfer (no copy) |
| postMessage with transfer list | ✓ | ✓ | `postMessage(msg, [buffer])` standard |
| SAB `.slice()` | ✗ | ✗ | SAB cannot be transferred; must copy for safety |
| `.subarray()` | ✗ | ✓ | Typed-array view; zero-copy but dangling after release |
| `.slice()` | ✓ | ✗ | Typed-array copy; creates new backing buffer |

---

## Key Invariants

1. **Input copies are per-batch**, not per-byte (batches coalesce chunks).
2. **Output copies are per-frame** (or per 256KB encode chunk).
3. **All transfers use postMessage transfer list** (ArrayBuffer detach, zero-cost).
4. **SAB requires `.slice()` copy** — SharedArrayBuffer cannot be transferred.
5. **HEAPU8 views are ephemeral** — memory can be reallocated; views must detach.
6. **Worker↔Main uses transfer, never copy** (except SAB exception above).
