# WASM ↔ Tauri Feature Parity Comparison & Action Plan

**Source:** "Overview and features of the CasaWASM JXL wrapper.md" (primary) + cross-check against Tauri README.md, raw-pipeline sources, src-tauri command layer, and shared web/ frontend usage.  
**Date:** 2026-05-28  
**Purpose:** Identify the minimal set of main features required for feature parity between the browser WASM converter (CasaWASM JXL + raw-pipeline wrapper) and the native Tauri desktop build. This table forms the actionable backlog for the transpose-wasm-to-tauri workstream.

The table focuses on **high-value, user-visible or performance-critical** items that are implemented and battle-tested on the WASM side (per the Overview) but are missing, duplicated, or only partially present on the Tauri side. Low-level shared dependencies (e.g., basic demosaic, decompress, tiff::parse) are omitted.

## Feature Parity Table

| #  | Feature | In WASM | WASM File Index | In Tauri | Tauri File Index | Importance (1-5) | Complexity (1-5) |
|----|---------|---------|-----------------|----------|------------------|------------------|------------------|
| 1  | LookRenderer – WASM/Rust-resident pre-tonemapped RGB16 buffer with zero-copy `render()` for live slider edits (exposure/contrast/clarity/etc.) without repeated full decode or cross-boundary pixel transfer | Yes (full `#[wasm_bindgen]` struct + `take_rgb16_lb` + internal `render`) | 1 | No (only one-shot `process_file` with LookOptions at ingest time; no retained renderer state or incremental re-render command) | 3 | 5 | 5 |
| 2  | `process_orf_with_flags` / selective output bitmask (1=full RGB8, 2=1800 px lightbox RGB16, 4=360 px thumb RGB16) – skips unused downscales/tonemaps for batch JXL encode paths | Yes (`process_orf_with_flags`, `OUT_*` constants, conditional paths in `process_orf_impl`) | 1 | No (process_file always materializes full + lightbox RGB8 + thumb; no caller-controlled bitmask) | 3 | 4 | 3 |
| 3  | `parse_orf_metadata` – TIFF/EXIF-only parse (make/model/lens/datetime/dims/orient/ISO/GPS/WB) with zero pixel decompression or demosaic | Yes (dedicated entrypoint, re-uses tiff parse only) | 1 | Partial (tiff::parse + exif::ExifData used inside full decode flow; no public metadata-only command or lib fn exposed for gallery preflight) | 2, 6 | 4 | 2 |
| 4  | `bench_decode_orf` – isolated decompress + demosaic stage timings (skips tonemap, downscale, orientation) for tuning | Yes (returns `DecodeBench` with per-stage ms) | 1 | Partial (standalone benches exist under `src-tauri/examples/` and `src-tauri/src/bin/`, but no stable library function or Tauri command for runtime use) | — | 3 | 2 |
| 5  | Thumbnail derived from lightbox buffer – downscale 360 px thumb from already-computed 1800 px lightbox RGB16 instead of second full-frame scan | Yes (explicit path in `process_orf_impl`) | 1 | No (downscale helpers in pipeline.rs always operate on the full-res RGB8 output) | 3 | 4 | 2 |
| 6  | Orientation==1 fast-path – in-place move (or zero-copy) of RGB buffer when EXIF orientation is identity (common case); avoids 60+ MB copy traffic on 20 MP images | Yes (explicit `if info.orientation == 1 { ... move ... }` in both `process_orf` and `apply_look` paths) | 1 | No (`apply_orientation` in raw-pipeline always does `rgb.to_vec()` or full rotate alloc even for orientation 1) | 1 | 3 | 1 |
| 7  | Unified `apply_look_params` helper – single private function with all 12 `is_finite` checks; eliminates duplication between preview and export paths | Yes (private `apply_look_params` called from `process_orf_impl`, `apply_look`, `LookRenderer::render`) | 1 | No (inline `if is_finite` blocks duplicated inside `build_params_from_look` in src-tauri pipeline layer) | 3 | 3 | 1 |
| 8  | `apply_look` accepts native `&[u16]` (flat RGB16) – eliminates per-call LE byte unpack (`chunks_exact(2).map(u16::from_le_bytes)`) | Yes (takes `rgb16_src: &[u16]` directly; only one `.to_vec()` for in-place unsharp when needed) | 1 | N/A (no equivalent public `apply_look` API; all edits are baked at initial `process_file` time) | — | 3 | 2 |
| 9  | Pre-allocated fixed-size buffers for `rgb_to_rgba` and box-filter downscales – upfront `vec![0u8; n*4]` or equivalent enables better vectorization vs repeated `extend` | Yes (explicit in lib.rs downscale + rgb_to_rgba paths) | 1 | Partial (downscale_rgb8 / downscale_rgb16 allocate inside par_chunks; no documented fixed-buffer strategy) | 3 | 2 | 1 |
| 10 | `decode_orf_raw` / `process_orf_impl` split – clean separation of (parse→demosaic→NR→WB/matrix) from (conditional downscale + WB override + tonemap + orient) | Yes (private split; both `process_orf` and `process_orf_with_flags` delegate) | 1 | No (monolithic logic inside `process_file` + `build_params_from_look`; hard to add selective outputs or metadata-only without refactor) | 3 | 3 | 3 |
| 11 | Preemptive priority lanes + pause/resume of in-flight decodes – visible/near/background tiers; background session suspended in-place (WASM decoder state preserved) rather than cancelled | Yes (full implementation across scheduler, pool, decode-handler; `decode_pause`/`decode_resume` protocol) | 4, 5 | Partial (priority_sem + `promote_to_front` for visible files; no suspend/resume of already-running Rust decode/encode tasks) | 4 | 5 | 4 |
| 12 | Progressive Encoding (preview-first / early passes) during RAW ingest – biases the encoder to emit a usable first pass quickly while converting large RAW files to JXL. Enables "instant" upload / lightbox previews on slow connections before the full codestream is ready. Includes streaming pixel input to the encoder and `streamingEncode` capability detection. | Yes (facade + bridge.cpp streaming encoder paths, "Preview-First Encoding" bias, early-pass emission, capability probe for streamingEncode) | 2, 3, 6 | No (casabio_encode.rs + the encode path in pipeline.rs use one-shot `jpegxl_rs` encode / encode_frame with Falcon speed and set_jpeg_quality; no progressive/streaming encode or early usable pass emission during RAW→JXL) | 3, 8 | 5 | 5 |
| 13 | Native libjxl Progressive Decode on Tauri – real `JXL_DEC_FRAME_PROGRESSION`, `JxlDecoderFlushImage`, and `JxlDecoderSetProgressiveDetail` event loop using jpegxl-sys (or low-level bindings). Emits incremental RGBA frames back to the frontend as the codestream advances, instead of the current JS "re-decode on growing prefix" workaround. | Partial (the WASM/browser progressive decode path is the re-decode workaround described in the repo's Tauri-progressive-implementation.md) | 2, 3 | No (desired native implementation using the real libjxl progressive state machine is not present; Tauri currently relies on full one-shot decode or the shared JS workaround for JXLs) | 3, 8 | 5 | 5 |
| 14 | JXTC Tile-Container Encode + Full Round-Trip ROI – ability to produce JXTC containers (`encodeTileContainerRgba8`) during RAW ingest/encode so that later exact crops, viewports, and lightbox regions on 100 MP+ files use the zero frame-walk overhead per-tile decoder path (`decodeTileContainerRegionRgba8`). This is the recommended primary ROI path (vs legacy multi-frame tiles or full-frame + crop). | Yes (facade + bridge.cpp; primary path in crop benchmark, JXTC unit tests, capability detection, and ROI examples; ~5–23× speedup on large crops) | 2, 3, 6 | No (current encode path only produces standard JXL variants via jpegxl-rs; no JXTC container production or round-trip support for fast native ROI) | 3, 8 | 4 | 4 |

## WASM files

These are the canonical implementation locations (or primary references) for the WASM-side features above. File numbers are referenced in the "WASM File Index" column.

1. `src/lib.rs` (raw-converter-wasm crate) – Primary home of LookRenderer, process_orf_with_flags, parse_orf_metadata, bench_decode_orf, apply_look, orientation fast-path, apply_look_params helper, decode_orf_raw/process_orf_impl split, and all raw-pipeline orchestration exposed to JS via wasm-bindgen.
2. `packages/jxl-wasm/src/facade.ts` – High-level TS API for JXTC ROI, exact-size viewport decode (`decodeViewport`, `decodeRegionLod`), progressiveDetail, region fallback flags, capability detection (including `streamingEncode`), and zero-copy WASM heap management.
3. `packages/jxl-wasm/src/bridge.cpp` – C++ FFI layer implementing JXTC container format, `downscale_rgba`, grow-only WASM allocator, streaming encoder (progressive + preview-first), and progressive event plumbing.
4. `packages/jxl-scheduler/src/scheduler.ts` (and `pool.ts`) – Preemptive scheduler with priority lanes (visible/near/background), deduplication, pause/resume, worker pool lifecycle, and adaptive backpressure.
5. `packages/jxl-worker-browser/src/decode-handler.ts` (and Node counterpart) – Per-worker decode state machine, budget enforcement, coalesced drain, pause/resume handling, terminal-state wakeup, and cold-start buffering.
6. Progressive / streaming encoder paths in `packages/jxl-wasm/src/facade.ts` (streamingEncode capability, preview-first bias, early-pass emission) and `bridge.cpp` (encoder pixel-chunk streaming and progressive encode support).

## Tauri files

These are the primary locations in the Tauri build that either already contain partial analogs or are the natural targets for porting the missing functionality. File numbers are referenced in the "Tauri File Index" column.

1. `raw-pipeline/src/pipeline.rs` – Core tone-mapping pipeline (PipelineParams, process/process_16bit, apply_orientation with its rotate helpers, clarity/texture Gaussian blur, LUT cache). Currently lacks the WASM-side fast paths and pre-alloc strategies.
2. `raw-pipeline/src/lib.rs` – Public module surface and compile/integration tests. No high-level process_orf_* or LookRenderer exports.
3. `src-tauri/src/pipeline.rs` – Tauri command layer (ProcessOptions, LookOptions, Rgb16State, process_file, build_params_from_look, downscale helpers, lightbox cache, get_large_preview, apply_orientation calls, and the encode entry point). Contains duplicated param-application logic and always-full output materialization.
4. `src-tauri/src/priority_sem.rs` – Custom semaphore with `promote_to_front` for visible-file priority. Good foundation for lane-based preemption but lacks in-flight suspend/resume.
5. `src-tauri/src/lib.rs` – AppState (lightbox_cache, file_semaphore), Tauri command registration, and overall desktop wiring.
6. `raw-pipeline/src/exif.rs` + `raw-pipeline/src/tiff.rs` – EXIF and TIFF parsing used by both sides. WASM adds the metadata-only entrypoint on top; Tauri currently only exercises these inside full decode.
7. `src-tauri/src/casabio.rs` – Casabio expedition-planner push integration (Tauri-specific; included for completeness as a desktop-only flow that should eventually consume the same high-level raw pipeline primitives).
8. `raw-pipeline/src/casabio_encode.rs` – jpegxl-rs based encoder producing thumb/preview/full variants (`encode_variants`, `encode_one`). Current one-shot implementation using Falcon speed, `set_jpeg_quality`, and Lanczos resize; no progressive/streaming encode, early-pass emission, or JXTC container support.

## Recommended Porting Order (Action Plan)

1. **High-ROI, low-complexity first (quick wins):** 6 (orientation fast-path), 7 (unified helper), 9 (pre-alloc buffers). These are almost pure refactors inside existing functions.
2. **High user value, medium effort:** 3 (metadata-only), 5 (thumb-from-lightbox), 2 (selective flags). Directly reduce work for gallery and batch paths.
3. **Flagship interactive feature:** 1 (LookRenderer). Requires new retained state in AppState + a new `render_look(id, params)` command + cache invalidation. Highest impact on desktop UX parity with browser lightbox.
4. **Architectural hygiene:** 10 (split raw decode vs process). Makes 2, 3, and 5 trivial to add later.
5. **New high-priority items from Progressive + ROI expansion (this revision):**  
   - 12 (Progressive Encoding during RAW ingest) – core to the "instant preview on slow connections / large scientific raws" promise.  
   - 13 (Native libjxl Progressive Decode on Tauri) – the "go for gold" implementation explicitly recommended in the repo's own `Tauri-progressive-implementation.md`.  
   - 14 (JXTC Encode + Round-Trip ROI) – best-in-class crop performance for 100 MP+ files; the recommended primary ROI path.  
   These three are now among the most important for large-file scientific workflows and responsive lightbox behavior while conversion is still running. They are also the highest complexity (mostly 5).
6. **Cross-cutting / harder (original):** 11 (true pause/resume of native decodes). May need new native primitives or careful integration with the existing priority_sem.

## Notes & Invariants

- Many pure-JXL progressive *decoding* and streaming scheduling features (sections 2 and 4 of the Overview) already achieve good parity because the Tauri desktop serves the identical `web/` frontend and can invoke the same `@casabio/jxl-session` / scheduler / worker stack for JXL decode of previously-encoded assets.  
  The **real remaining gaps** (now given dedicated rows 12–14) are:
  - Progressive *encoding* while ingesting RAW (preview-first / early passes).
  - True native progressive *decode* on the Rust/Tauri side using libjxl's event machine (instead of the JS workaround).
  - JXTC tile-container *encode* + full round-trip ROI support.
- The raw-pipeline crate is already a shared dependency (WASM Cargo.toml points at `../raw-converter-tauri/raw-pipeline`). The highest-leverage move is to lift the orchestration types (LookRenderer, OrfMetadata, DecodeBench, selective flags) **into the shared crate** rather than duplicating in both wasm-bindgen wrapper and Tauri command layer. The same principle applies to any new progressive-encode or JXTC types.
- All importance/complexity scores are relative to achieving production parity for scientific imaging use (Casabio biodiversity workflows) on both platforms. Rows 12 and 13 are scored at 5/5 importance because they directly affect the perceived responsiveness of the desktop app on the exact workloads the Overview was built for (large raws, slow connections, interactive lightbox editing).

This document is the single source of truth for the transpose effort. Update the "In Tauri" column and file indices as ports land.
