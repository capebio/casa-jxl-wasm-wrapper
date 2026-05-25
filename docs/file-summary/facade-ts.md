# Working Notes: packages/jxl-wasm/src/facade.ts
> WASM FFI layer — heap management, capability detection, decoder/encoder lifecycle
> Features covered: #1 (Build Architecture), #3 (Scientific Correctness / Metadata)

---

## Index of Exports

| Symbol | Kind | Purpose |
|--------|------|---------|
| `createDecoder(options)` | fn | Returns `LibjxlDecoder` — progressive or one-shot based on capability |
| `createEncoder(options)` | fn | Returns `LibjxlEncoder` — streaming-input or buffered path |
| `transcodeJpegToJxl(jpeg)` | fn | Lossless JPEG→JXL via `#15` bridge |
| `preloadJxlModule()` | fn | Eagerly starts WASM load without blocking |
| `detectTier()` | fn | SIMD/SAB probe → one of: relaxed-simd-mt / simd-mt / simd / scalar |
| `recommendedEffort()` | fn | Tier-aware effort 4–7 |
| `setForcedTier(tier\|null)` | fn | Override tier for testing |
| `CapabilityMissing` | class | Error thrown when bridge function absent |

---

## Feature #1 Coverage

| Feature | Status | Location |
|---------|--------|---------|
| Zero-Copy WASM Writes | ✅ Full | `HEAPU8.set(chunk, chunkBufPtr + woff)` in `eventsProgressive` |
| Grow-Only WASM Allocator | ✅ Full | `chunkBufPtr` grows only: `if (batchBytes > chunkBufCap) { _free; _malloc(batchBytes) }` |
| FFI Overhead Reduction | ✅ Full | Bridge fn refs cached at session start (lines 407–414); `HEAPU32` direct struct read in `readBufferView` |
| Module Caching | ✅ Full | `modulePromise ??= ...` singleton; `capabilityCache` WeakMap per module |
| Multi-Tiered WASM Matrix | ✅ Full | `detectTier()` → `jxl-core.${tier}.js`; result cached in `_cachedDetectedTier` |
| Tier-Aware Effort Default | ✅ Full | `recommendedEffort()` |
| Streaming Input Encoder (#16) | ✅ Full | `enc_create_image` → `enc_push_chunk` → `enc_finish` — JS never accumulates pixels[] |
| Immediate Chunk Slot Release | ✅ Full | `chunkQueue[readIndex++] = null` after `HEAPU8.set` — GC-eligible immediately |
| Progressive Decode | ✅ Full | `eventsProgressive()` with `_jxl_wasm_dec_create` when capability present |
| ROI / Region Decode (#10) | ✅ Full | C++ region crop via `_jxl_wasm_decode_rgba8_region` (avoids JS pixel transfer) |
| Sidecar Thumbnails | ✅ Full | `_jxl_wasm_encode_rgba8_with_sidecars` with cascade downscale |
| Compression Ratio Feedback | ✅ Full | `getStats()` → `EncodeStats { originalBytes, compressedBytes, ratio }` |
| JPEG Transcode (#15) | ✅ Full | `transcodeJpegToJxl()` via `_jxl_wasm_transcode_jpeg_to_jxl` |

---

## Feature #3 Coverage

| Feature | Status | Notes |
|---------|--------|-------|
| Metadata Round-trip (rgba8) | ✅ Full | ICC/EXIF/XMP passed to `_jxl_wasm_encode_rgba8_with_metadata` |
| Metadata Round-trip (rgba16/rgbaf32) | ✅ Fixed | Streaming input path now disabled when metadata present (`!hasMetadataOpts` guard); buffered path routes through `_jxl_wasm_encode_rgba8_with_metadata` which now accepts `fmt` param. Verified: 2026-05-25 |
| Alpha Channel Integrity | ✅ Full | `hasAlpha` flag propagated; no forced premul |
| HDR (rgba16 / rgbaf32) | ✅ Full | Capability-checked; all paths support multi-format |

---

## Bottlenecks & Issues

### 🟢 B1 — Metadata silently dropped for HDR encodes ✅ FIXED (C1)
**Status: FIXED** — Streaming input path is now disabled when any metadata option (ICC/EXIF/XMP) is present. The guard `!hasMetadataOpts` was added to the `if (!wantSidecars && caps.streamingInput)` condition. When metadata is present, the encoder falls back to the buffered path which routes through `_jxl_wasm_encode_rgba8_with_metadata`, which now accepts a `fmt` parameter in bridge.cpp (supports rgba8/rgba16/rgbaf32).
Verified: 2026-05-25

### 🟢 B2 — `progressive` encoder option now throws `CapabilityMissing` ✅ FIXED
**Status: FIXED** — `finish()` now throws `CapabilityMissing` when `options.progressive === true` rather than silently producing a non-progressive file.
Fix: `if (this.options.progressive) { throw new CapabilityMissing("Progressive JXL encode requires a rebuilt WASM...") }` added in `finish()` before the encode path.
`previewFirst` and `chunked` remain documented no-ops (no WASM bridge support). Only `progressive` was guarded.
Verified: 2026-05-25

### 🟡 B3 — ROI decode still decodes full image in C++
`DecodeRgbaRegion` (bridge.cpp) calls `DecodeRgba` first (full decode + downsample), then crops. For large images with small ROIs, this wastes significant decode time.
**Fix:** Use libjxl's `JxlDecoderSetCropEnabled` (if available in the linked version) to decode only the cropped region from the bitstream.

### 🟢 B4 — HEAPU32 fast path requires aligned handle (minor)
`readBufferView` falls back to 6 individual FFI calls if handle is unaligned or small (< 16). Production handles are always aligned; test modules use small integers. Fallback is correct but slower.

---

## Key Invariants

- `eventsProgressive` batches ALL queued chunk bytes into one `HEAPU8.set` + `dec_push` per event-loop tick (IMPROVEMENT-7).
- `chunkBufPtr` is a grow-only single buffer; freed in `finally` block.
- `modulePromise` is reset by `setForcedTier()` and `setJxlModuleFactoryForTesting()`.
- `copyInput !== false` (default true): ArrayBuffer inputs are always zero-copy views; Uint8Array inputs are copied to prevent caller mutation.
- `eventsOneShot`: writes all chunks into one WASM heap buffer (no intermediate JS concat); `allChunks.length = 0` after copy to release refs.
- `LibjxlDecoder.dispose()` — also wakes pending `waitForQueueItem()` via `wake()` to unblock the event iterator.
- Chunk slots nulled immediately after WASM copy so GC can reclaim Uint8Arrays before the decode completes.
