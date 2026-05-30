# Handoff: Deferred EpicCodeReview Items

This document outlines the status and required actions for the items deferred during the EpicCodeReview (2026-05-15). All listed items are now closed; Q5 and Q6 still have optional manual checks for visual or memory behavior.

## Summary of Status

| ID | Topic | Severity | Status | Action Required |
|----|-------|----------|--------|-----------------|
| Q1 | OM SYSTEM MakerNote Offset | HIGH | **CLOSED** | None (Verified correct) |
| Q2 | wasm-bindgen Copy Guarantee | LOW | **CLOSED** | None (Comment added to `lib.rs`) |
| Q3 | Vertical-pass Blur Optimization | MEDIUM | **CLOSED** | None (tiled-128 integrated for wasm path; benchmark fixed to report full round-trip) |
| Q4 | Pre-LUT Size (65k vs 4k) | LOW | **CLOSED** | None (Retained 65k for DNG support) |
| Q5 | Histogram Downsampling | MEDIUM | **CLOSED** | None (Implemented in `panels.js`) |
| Q6 | liveStateMap Memory Leak | MEDIUM | **CLOSED** | None (Implemented in `main.js`/`worker.js`) |
| Q7 | strip_offset Validation | MEDIUM | **CLOSED** | None (Verified as already implemented) |

---

## Detailed Handoff & Instructions

### Q3: Vertical-pass Cache Thrash (Closed)
**Context:** Benchmark results showed that the naive vertical blur pass is a bottleneck due to cache thrashing. A `tiled-128` implementation was found to be ~38% faster.
**Status:** The wasm build depends on `raw-pipeline` with `default-features = false`, which uses the tiled `VTILE = 128` vertical pass in `separable_blur_with_bufs`. The local `blur_bench` now includes `tiled-128` in the full round-trip section, so the verification command measures the recommended path directly.
**Verification:** Run `cargo run --bin blur_bench --release` and compare `naive` vs `tiled-128` in both the vertical-only and full round-trip sections.

### Q6: liveStateMap Memory Leak (Closed)
**Context:** Reprocessing the same image multiple times orphaned large RGB16 buffers in worker memory (~15MB per reprocess).
**Implementation Details:**
- `web/main.js`: `WorkerPool.releaseState(taskId)` now called before re-submitting a card.
- `web/worker.js`: `release_state` handler added to free `LookRenderer` and delete map entries.
**Status:** Verified in code: `WorkerPool.releaseState(taskId)` posts `release_state`; `startConvert` calls it before replacing `card._taskId`; the worker frees and deletes both `liveStateMap` and `thumbStateMap` entries.
**Optional manual check:** Monitor worker memory during repeated "Apply" clicks on one high-resolution image.

### Q5: Histogram Downsampling (Closed)
**Context:** Computing histograms for 20MP images was slow. An adaptive stride sampling ~500K pixels was implemented.
**Implementation Details:**
- `web/panels.js`: `computeHistogram` now uses a calculated `stride`.
**Status:** Verified in code: `computeHistogram` uses adaptive RGBA stride targeting about 500,000 sampled pixels.
**Optional manual check:** Compare histogram stability while toggling images and adjusting levels.

### Q1 & Q7: Metadata Robustness (Closed)
**Status:** Both were investigated and found to be handled correctly. 
- **Q1:** OM SYSTEM headers (`+16` offset) are handled by the current TIFF parser.
- **Q7:** `validate_orf_structure()` in `lib.rs` already performs bounds checking for strips.
**Action:** No code changes needed. Maintain current test coverage for ORF parsing.

---
*Prepared for Handoff — 2026-05-15*
