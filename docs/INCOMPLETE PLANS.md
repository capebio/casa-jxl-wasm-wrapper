# Incomplete Plans & Outstanding Backlog

This document consolidates the remaining tasks, goals, and follow-ups for the Tauri ↔ WASM Parity Program. These are the active "things to do" on the Tauri/Native side to achieve full production parity with the completed WASM stack.

---

## 🎯 Phase 2: Pyramid Gallery Product Parity

### 📦 1. Milestone M2: 8-bit Lightbox Parity (PR-8b / PR-9)
*   [ ] **Zoom Ladder**: Implement adaptive `screenLongEdge × DPR` zoom-level selection inside the Tauri lightbox.
*   [ ] **Pan Without Re-decode**: Ensure that panning zoomed-in canvases on Tauri utilizes 2D matrix transformations only, preventing redundant re-decodes.
*   [ ] **Contenthash LRU**: Add a monotonic, contenthash-keyed, 8-entry screen-bitmap cache (LRU) to prevent re-decoding when flipping between recent files.

### 📦 2. Milestone M3: 16-bit RAW / WebGL (PR-9b)
*   [ ] **16-bit Ingest**: Ensure the native pyramid ingester saves `bits_per_sample: 16` JXL files for `{2048, full}` RAW levels.
*   [ ] **16-bit ROI Export**: Complete high-precision 16-bit crop export (currently, Tauri crop exports fallback to 8-bit PNG downsampling).
*   [ ] **16-bit HDR Toggle**: Fully wire the user-facing "16-bit HDR" toggle to trigger the high-precision WebGL float-texture renderer on the native desktop.

### 📦 3. Milestone M4: Massive Tiling (PR-10b)
*   [ ] **Parallel Tiled ROI Decode**: Complete the native parallel thread pool to load, parse, and decode multiple tile JXL buffers concurrently under `rayon`.
*   [ ] **Image Stitching**: Stitch decoded tile pixel slices into a single lightbox viewport image buffer inside the Tauri FFI layer.
*   *Verification*: Run `cargo +stable-x86_64-pc-windows-msvc run --bin pyramid_bench --release` to verify parallel stitching is $\ge 1.75\times$ faster than sequential.

---

## 🏎️ Phase 1: High-Performance Polish

*   [ ] **H34 (Full Sneyers Encode)**: Add support for native progressive AC knobs (`progressiveAc`, `qProgressiveAc`, and `preview_first`) to match the WASM-side Sneyers et al. compression limits.
*   [ ] **H35 / H39 (Viewport ROI Region Decodes)**: Replace the legacy lightbox prefill (which decodes full masters and downscales) to load sub-rect crops natively using `decode_jxl_region_for_id`.
*   [ ] **H38 (SlabPool)**: Land the hot-path allocator memory-reuse pool in Rust to reduce Vec allocation churning on massive images.
*   [ ] **H33 (Preview-First JPEG Reconstruction)**: Implement the native JPEG reconstruction decode path.
*   [ ] **H14 / H43 (Texture Deduplication & Event Flush)**: Add the native hash-gating mechanism before WebView texture uploads and throttle renders.

---

## 📡 Phase 3: Legacy Refinements (Non-Pyramid Progressive Assets)

*   [ ] **PSNR $\ge 40$ dB Regression Gate**: Integrate the progressive-pass quality checks into the cargo/CI testing pipeline.
*   [ ] **Canvas ImageData Slack**: Secure the Tauri IPC channels with native coordinate and buffer bounds validators.
*   [ ] **A3/A4 Texture Reuse**: Port web-side stats-gating and GPU texture recycle controls to the Tauri frontend.

---

## 📊 Infrastructure & Benchmarking

*   [ ] **PR-11 (Unified Bench Harness)**: Align `raw_decode_bench`, `lightbox_bench`, and `pyramid_bench` outputs to match the WASM `onMetric` JSON telemetry schema exactly.
*   [ ] **H15 (Content-Hash Dedupe)**: Implement scheduler/contenthash dedupe on Tauri (currently id-only cache).
*   [ ] **H41 (Prefix-Probe)**: Port native prefix-probe code for harness validation.
