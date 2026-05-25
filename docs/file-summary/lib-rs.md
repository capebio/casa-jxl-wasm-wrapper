# Working Notes: src/lib.rs
> RAW pipeline WASM entry point — ORF/DNG → RGB8/16 pixel buffer
> Features covered: #1 (Build Architecture), #3 (Scientific Correctness)

---

## Index of Exports

| Symbol | Kind | Purpose |
|--------|------|---------|
| `ProcessResult` | struct | Full decode output: RGB8, lb RGB16, thumb RGB16, EXIF metadata |
| `process_orf()` | fn | Full ORF decode (always all 3 outputs) |
| `process_orf_with_flags()` | fn | Selective ORF decode via bitmask (OUT_FULL_RGB8=1, OUT_LIGHTBOX=2, OUT_THUMB=4) |
| `process_dng()` | fn | DNG decode — thin wrapper over `process_dng_impl` (all 3 outputs) |
| `process_dng_with_flags()` | fn | Selective DNG decode via bitmask — mirrors `process_orf_with_flags` |
| `apply_look()` | fn | Re-tonemap from cached RGB16 `&[u16]` |
| `LookRenderer` | struct | WASM-resident state; slider edits stay in WASM |
| `parse_orf_metadata()` | fn | Metadata-only parse, no decompress/demosaic |
| `bench_decode_orf()` | fn | Decompress+demosaic timing only |
| `downscale_rgb()` | fn | Box-filter RGB8 downscale |
| `downscale_rgba()` | fn | Box-filter RGBA8 downscale (alpha preserved, no premul) |
| `rotate_rgb8()` | fn | 90/180/270° rotation |

---

## Feature #1 Coverage

| Feature | Status | Location |
|---------|--------|---------|
| Selective Output Bitmask | ✅ Full | `process_orf_with_flags()` + `process_dng_with_flags()` — `OUT_FULL_RGB8\|OUT_LIGHTBOX\|OUT_THUMB` |
| Orientation 1 Fast-Path | ✅ Full | Both ORF and DNG paths: `if orientation == 1 { skip }` |
| Thumbnail from Lightbox Buffer | ✅ Full | Thumb downscaled from lb when both flags set |
| Unified Look-Parameter Helper | ✅ Full | `apply_look_params()` called in all paths |
| WASM-Side RGBA Resize | ✅ Full | `downscale_rgb()`, `downscale_rgba()`, `downscale_rgb16_impl()` |
| LookRenderer (WASM-Resident State) | ✅ Full | `render()` only returns RGB8; no-clone path when texture/clarity=0. Verified: 2026-05-25 |
| Native `&[u16]` Support for `apply_look` | ✅ Full | Takes `&[u16]` directly |
| Metadata-Only Parse | ✅ Full | `parse_orf_metadata()` — no pixel work |
| Decode Benchmark | ✅ Full | `bench_decode_orf()` — per-stage ms |
| Shared ORF Pipeline | ✅ Full | `decode_orf_raw()` + `process_orf_impl()` |
| Shared DNG Pipeline | ✅ Full | `decode_dng_raw()` + `process_dng_impl()` + `DngDecoded` struct |
| Safe Pixel Allocation | ✅ Full | `validate_orf_structure()` — bounds + overflow guards |
| Pre-Allocated `rgb_to_rgba` Buffer | ⚠️ Broken | `rgb_to_rgba()` allocates `vec![0u8; n*4]` fresh every call — no pre-allocation |

---

## Feature #3 Coverage

| Feature | Status | Notes |
|---------|--------|-------|
| High Dynamic Range | ✅ Full | RGB16 throughout; lb/thumb buffers are u16 LE |
| Color Management | ✅ Full | Per-shot color matrix from MakerNote; sRGB pipeline |
| Alpha Channel Integrity | ✅ Full | `downscale_rgba` averages alpha without premul |
| Metadata Round-trip | ⚠️ Gap | lib.rs reads EXIF; ICC/XMP preservation happens in JS JXL encode path — connection not visible here |

---

## Bottlenecks & Issues

### 🟢 B1 — `process_dng_with_flags` implemented ✅ FIXED (G1)
**Status: FIXED** — `process_dng_with_flags` is now implemented. Internals refactored into `DngDecoded` struct + `decode_dng_raw()` + `process_dng_impl(output_flags, ...)`. `process_dng()` is now a thin wrapper that passes `OUT_FULL_RGB8 | OUT_LIGHTBOX | OUT_THUMB`. Mirrors the ORF pattern exactly.
Verified: 2026-05-25

### 🟢 B2 — `apply_look` conditional clone ✅ FIXED (G2)
**Status: FIXED** — Clone is now deferred: `let rgb8 = if params.texture != 0.0 || params.clarity != 0.0 { let mut rgb16 = rgb16_src.to_vec(); ... } else { pipeline::process(rgb16_src, &params) }`. The common no-sharpening path avoids the full-resolution copy.
Verified: 2026-05-25

### 🔵 B3 — DNG NR ISO hardcoded (G3 REVERTED with TODO)
**Status: REVERTED with TODO** — `DngImage` in the external `raw_pipeline` crate has no `iso` field. The NR lookup remains at hardcoded `let iso = 100u32` with a `// TODO(G3):` comment. The color matrix fields are also absent from `DngImage` — C3 requires the same upstream crate changes. Requires `raw-converter-tauri/raw-pipeline` crate to expose ISO and color matrix before this can be wired up.

### 🟡 B4 — DNG color matrix is identity placeholder
`color_matrix_flat: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]` — explicitly labeled placeholder. Breaks color fidelity for DNG files in `LookRenderer` (which uses this matrix for re-renders).
**Fix:** Extract camera color matrix from DNG metadata if available; pass through `dng_img`.

### 🟢 B5 — `rgb_to_rgba` no pre-allocation (minor)
Each call allocates a fresh buffer. Could use a thread-local or static buffer, but this is a low-frequency utility — low priority.

---

## Cross-Layer Connections

- **→ LookRenderer**: JS gets `take_rgb16_lb()` / `take_rgb16_thumb()` from `ProcessResult`, constructs `LookRenderer` with those bytes. After that, only RGB8 crosses the boundary per render call.
- **→ facade.ts / bridge.cpp**: Zero-copy writes and grow-only allocator are in the JXL encode path (not this file). `lib.rs` only handles the RAW → RGB pipeline.
- **→ jxl-cache**: `ProcessResult` buffers are passed upstream; lib.rs is unaware of caching.
- **→ Feature #2 (Scheduling)**: lib.rs functions are called synchronously inside WASM workers; they are not async and have no awareness of scheduler/budget. Budget checks happen in `decode-handler.ts` around the `process_orf`/`process_dng`/`process_dng_with_flags` call.

---

## Key Invariants

- `decode_orf_raw()` runs parse → validate → decompress → demosaic → NR. Tonemap is separate in `process_orf_impl()`.
- `decode_dng_raw()` mirrors the above for DNG: returns `DngDecoded`. `process_dng_impl()` handles flags + tonemap.
- `downscale_rgb16_impl()`: y-bounds hoisted outside dx loop. Box filter, not bilinear.
- WB: camera MakerNote WB unconditionally trusted if present. Gray-world fallback only when absent.
- All buffers transferred with `std::mem::take()` — caller owns; subsequent calls return empty vec.
- DNG orientation fast-path: `if dng_img.orientation == 1 { skip apply_orientation }`.
