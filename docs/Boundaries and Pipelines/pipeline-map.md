# JXL Pipeline Map — Decode & Encode Node Graph

## Decode Pipeline (Progressive)

Full encode+decode node graph. For each node: name, responsibility, input, output.

```
Source (ReadableStream / fetch / OPFS)
  ↓ [Uint8Array chunks]
Fetch → Headers → Size estimate
  ↓ [binary JXL]
DecodeSession.push(chunk)
  ↓ [toTransferableBuffer: ArrayBuffer transferred]
scheduler.send(sessionId, { type: "decode_push", data })
  ↓ [postMessage transfer]
Worker.onmessage → route to DecodeHandler
  ↓ [data ArrayBuffer]
DecodeHandler.onChunk(buffer)
  ├─ ChunkRing: store buffer reference
  ├─ if (chunkQueue reaches HWM) → postMessage(worker_drain) → worker pauses
  ↓ [feedDecoder logic]
ChunkRing → HEAPU8.set(chunk, chunkBufPtr+woff)
  ↓ [COPY #1: JS → WASM heap]
facade.push(chunkBufPtr, batchBytes) → decPush(dec, ptr, size)
  ↓ [WASM: libjxl decode loop]
libjxl (internal chunkBuf parsing, frame decoding)
  ├─ Events: header, progress, frame_metadata, pixels_decoded
  ↓ [WASM output handle per frame]
takeAndWrap: decTakeFlushed(dec)
  ├─ HEAPU8.subarray(outPtr, size) → view [zero-copy]
  ├─ new Uint8Array(view.buffer.slice(...)) [COPY #2]
  ├─ applyRegionAndDownsample [JS O(W×H) if region set]
  ├─ applyTargetResize [JS O(W×H) bilinear if target dims]
  ↓ [Uint8ClampedArray]
toTransferablePixels
  ├─ [if MT: SAB.slice(ptr, len)] → COPY #2.5 (MT-only)
  ├─ [else: buffer as-is]
  ↓ [ArrayBuffer or SAB ArrayBuffer]
postMessage({ type: "frame_pixels", pixels, ... }, [pixels.buffer])
  ↓ [transfer (zero-cost)]
decode-session.handleMessage → frameStream.push(frame)
  ↓ [reference]
Consumer (UI / Pyramid / Cache)
```

### Key Responsibilities

| Node | Role |
|------|------|
| **Source** | Fetch or streaming read; emit chunks |
| **DecodeSession** | Public API; manage per-session budget, emit frameStream events |
| **scheduler** | Dedup, preemption, pool management, worker tile assignment |
| **Worker** | Message routing, state machine per handler |
| **DecodeHandler** | libjxl session state, chunk batching, backpressure via drain signal |
| **ChunkRing** | O(1) circular queue of Uint8Array references |
| **facade (push path)** | HEAPU8.set batch, malloc grow, decPush call, timing |
| **facade (take path)** | decTakeFlushed, subarray, copy, region/resize JS logic |
| **toTransferablePixels** | SAB detection + `.slice()` copy if needed (MT only) |

---

## Encode Pipeline (Streaming Input)

```
RGBA Source (Uint8ClampedArray or canvas)
  ↓ [per-push chunks]
encode-session.pushPixels(pixels, ...)
  ↓ [toTransferableBuffer: ArrayBuffer transferred]
scheduler.send(sessionId, { type: "encode_pixels", chunk })
  ↓ [postMessage transfer]
Worker.onmessage → route to EncodeHandler
  ↓ [pixels ArrayBuffer]
EncodeHandler.onPixels
  ├─ enqueue into pixelQueue (zero-copy reference)
  ├─ if (queue size > HWM) → backpressure via postMessage(worker_drain)
  ↓ [feedEncoder logic]
pixelQueue → HEAPU8.set(view, enc_pixels_ptr)
  ↓ [COPY #1: JS → WASM heap]
facade.pushPixels(ptr, W, H, format)
  ↓ [WASM: libjxl encode loop]
libjxl (internal encode state machine)
  ├─ Events: header_complete, frame_encoded
  ↓ [WASM internal buffers]
enc_take_chunk() → HEAPU8.slice(dataPtr, size)
  ↓ [COPY #2: WASM → JS (256KB chunks)]
toTransferableBuffer
  ↓ [ArrayBuffer]
postMessage({ type: "encode_chunk", data }, [data.buffer])
  ↓ [transfer (zero-cost)]
encode-session.handleMessage → emit chunk via onData
  ↓ [reference]
Consumer (write to file / upload / cache)
```

### Key Responsibilities

| Node | Role |
|------|------|
| **encode-session** | Public API; manage pixel stream, push queueing, emit chunks |
| **scheduler** | Load balance, preemption control (pause/resume) |
| **Worker** | Message routing, state machine per handler |
| **EncodeHandler** | libjxl encoder state, streaming input protocol, chunk extraction |
| **pixelQueue** | O(1) FIFO of pixel chunk references |
| **facade (pushPixels path)** | HEAPU8.set batch, enc_pixels_ptr call, timing |
| **facade (takeChunk path)** | enc_take_chunk, slice copy, output buffer management |

---

## Data Flow Summary

### Decode: 2 Copies Per Frame (Necessary)
1. **Chunks → WASM**: `HEAPU8.set(chunk, chunkBufPtr)` — input accumulation
2. **WASM → JS**: `new Uint8Array(subarray)` in `takeAndWrap` — output detach
   - (Plus 1 optional SAB copy on MT tier for shared memory safety)

### Encode: 2 Copies Per Push (Necessary)
1. **Pixels → WASM**: `HEAPU8.set(view, enc_pixels_ptr)` — input submission
2. **WASM → JS**: `HEAPU8.slice(dataPtr, size)` — output chunk extraction

Both pipelines use **ArrayBuffer.transfer** at worker↔main boundary (zero-cost).
