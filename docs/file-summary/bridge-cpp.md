# Working Notes: packages/jxl-wasm/src/bridge.cpp
> C++ FFI — libjxl session state, grow-only buffers, streaming encoder, region crop, sidecar chain
> Features covered: #1 (Build Architecture), #3 (Scientific Correctness / Metadata)

---

## Index of Key Structs & Exports

| Symbol | Kind | Purpose |
|--------|------|---------|
| `JxlWasmBuffer` | struct | Output buffer — data + dims + error + next-chain ptr |
| `JxlWasmDecState` | struct | Progressive decoder state — grow-only pixels + flushed buffers |
| `JxlWasmEncState` | struct | Streaming encoder state — pre-alloc pixel buf (#16) + output buf |
| `jxl_wasm_dec_create` | fn | Creates progressive decoder state with optional `JXL_DEC_FRAME_PROGRESSION` |
| `jxl_wasm_dec_push` | fn | Feeds data; returns NEED_MORE / PROGRESS / DONE / ERROR |
| `jxl_wasm_dec_take_flushed` | fn | Zero-copy ownership transfer of flushed intermediate frame |
| `jxl_wasm_dec_take_final` | fn | Zero-copy ownership transfer of final frame |
| `jxl_wasm_enc_create_image` | fn | #16: pre-alloc full pixel buffer; no JS accumulation needed |
| `jxl_wasm_enc_push_chunk` | fn | #16: memcpy chunk into pre-alloc'd pixel buffer |
| `jxl_wasm_enc_finish` | fn | Encode + free pixel buffer; output available via `enc_take_chunk` |
| `jxl_wasm_enc_take_chunk` | fn | Yields 256 KB output chunks (comment says 64 KB — mismatch, actual = 256 KB) |
| `jxl_wasm_encode_rgba8_with_metadata` | fn | ICC/EXIF/XMP encode — **only exposes fmt=0 (rgba8)** |
| `jxl_wasm_encode_rgba8_with_sidecars` | fn | Cascade sidecar thumbnail encode + full image in one call |
| `jxl_wasm_decode_rgba8/16/rgbaf32_region` | fn | Region crop — decodes full then crops in C++ |
| `jxl_wasm_transcode_jpeg_to_jxl` | fn | #15: lossless JPEG→JXL |
| `jxl_wasm_buffer_free` | fn | Handles both inline data (MakeBuffer) and owned ptrs (MakeBufferFromOwned) |

---

## Feature #1 Coverage

| Feature | Status | Location |
|---------|--------|---------|
| Zero-Copy WASM Writes (decode) | ✅ Full | `JxlDecoderSetImageOutBuffer` — libjxl writes directly into pre-alloc'd `pixels_raw` |
| Zero-Copy Ownership Transfer | ✅ Full | `MakeBufferFromOwned`: caller transfers ownership; no memcpy. `dec_take_flushed/final` null out ptr after transfer |
| Grow-Only Allocator (decoder) | ✅ Full | `jxl_wasm_dec_push`: `realloc` on `pixels` and `flushed` only when `buf_size > pixels_size` |
| Grow-Only Buffer (encoder output) | ✅ Full | `EncodeRgbaWithMetadata`: `realloc(outbuf, outbuf_cap *= 2)` on `NEED_MORE_OUTPUT` |
| raw malloc (no zero-init) | ✅ Full | IMPROVEMENT-2/3: `pixels_raw = malloc(buf_size)` not `new std::vector<uint8_t>` |
| Streaming Encoder #11 | ✅ Full | `enc_create` → `enc_push_pixels` → `enc_take_chunk` (256 KB slices) |
| Streaming Input #16 | ✅ Full | `enc_create_image` pre-allocs full pixel buffer; freed after `enc_finish` |
| Sidecar Cascade | ✅ Full | Each thumbnail downscaled from previous (not from full image) — O(output pixels) not O(n_sidecars × full) |
| JPEG Transcode #15 | ✅ Full | `JxlEncoderStoreJPEGMetadata(JXL_TRUE)` + `JxlEncoderAddJPEGFrame` |
| ROI Region Crop #10 | ⚠️ Partial | Decodes full image first, then crops in C++ — not true bitstream-level ROI |

---

## Feature #3 Coverage

| Feature | Status | Notes |
|---------|--------|-------|
| ICC Profile Embed | ✅ Full | `JxlEncoderSetICCProfile` in `EncodeRgbaWithMetadata` |
| EXIF Embed | ✅ Full | `JxlEncoderAddBox("Exif", ...)` |
| XMP Embed | ✅ Full | `JxlEncoderAddBox("xml ", ...)` |
| Metadata for rgba16/rgbaf32 | ✅ Fixed | `jxl_wasm_encode_rgba8_with_metadata` now accepts `fmt` param (0=rgba8, 1=rgba16, 2=rgbaf32); forwards to `EncodeRgbaWithMetadata(... fmt ...)`. Verified: 2026-05-25 |
| Alpha Integrity | ✅ Full | `BoxDownscaleRgba8` averages all 4 channels including alpha |
| HDR pixel formats | ✅ Full | `FormatToDataType` supports JXL_TYPE_UINT8/16/FLOAT throughout |

---

## Bottlenecks & Issues

### 🟢 B1 — Metadata-aware export now supports all pixel formats ✅ FIXED (C1 partial)
**Status: FIXED** — `jxl_wasm_encode_rgba8_with_metadata` now accepts a `fmt` parameter (0=rgba8, 1=rgba16, 2=rgbaf32) and passes it directly to `EncodeRgbaWithMetadata`. The internal function already handled all formats; the export was the only bottleneck. See facade.ts for the companion guard (`!hasMetadataOpts`) that routes HDR encodes with metadata through this path.
Verified: 2026-05-25

### 🟢 B2 — ICC + sRGB color encoding conflict resolved ✅ FIXED (G4)
**Status: FIXED** — `JxlColorEncodingSetToSRGB` is now called only in the `else` branch (when `icc_profile == nullptr || icc_size == 0`). When an ICC profile is present, only `JxlEncoderSetICCProfile` is called. A comment was added explaining why: "ICC profile already fully describes the colour space. Setting sRGB color encoding afterwards is redundant and may produce undefined behaviour."
Verified: 2026-05-25

### 🟡 B3 — Chunk comment says 64 KB, actual chunk size is 256 KB
`jxl_wasm_enc_take_chunk`: `static const size_t CHUNK = 262144` (256 KB). The struct comment at line 25 says "yield output in 64 KB chunks". Minor inconsistency; 256 KB is better (fewer FFI crossings), but the comment misleads.

### 🟡 B4 — ROI decode: full image decoded then cropped
`DecodeRgbaRegion` calls `DecodeRgba` (full decode + downsample) then crops the resulting pixel buffer. For a small ROI on a 100 MP image, this wastes decode work proportional to `(image_area - roi_area) / image_area`.
**Workaround (current):** Downsample before crop reduces waste. Proper fix requires libjxl-level crop support.

### 🟢 B5 — `dec_push` pre-allocation on BASIC_INFO (minor positive note)
`jxl_wasm_dec_push` pre-allocs `pixels` buffer when `JXL_DEC_BASIC_INFO` arrives (line 484). This avoids a malloc on `NEED_IMAGE_OUT_BUFFER`. If `realloc` can extend in-place, there's zero copy — already optimal.

---

## JxlWasmBuffer Layout (WASM32)
```
offset  field
0       data*        (4 bytes)
4       size         (4 bytes)
8       width        (4 bytes)
12      height       (4 bytes)
16      bits_per_sample (4 bytes)
20      has_alpha    (4 bytes)
24      error        (4 bytes)
28      next*        (4 bytes)
= 32 bytes total, 4-byte aligned — safe for HEAPU32 direct read in facade.ts
```

## Key Invariants

- `MakeBufferFromOwned`: on malloc failure, frees `data` and returns `nullptr` — no leak.
- `jxl_wasm_buffer_free`: distinguishes inline data (`data == buf + 1`) from owned ptr — frees correctly.
- Sidecar chain: caller walks `->next` and calls `buffer_free` on each node individually.
- `enc_free`: `free(pixels_buf)` is no-op after `enc_finish` (set to null); safety net for cancel.
- `dec_take_final/flushed`: zero-copy — pointer transferred out, nulled in state. `dec_free` safely no-ops.
- Progressive decoder: on `FRAME_PROGRESSION`, flushes to `s->flushed`, then restores `s->pixels` as main buffer.
