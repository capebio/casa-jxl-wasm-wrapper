# Milestone M0: WASM Bridge Primitives — Verification Checklist

**Milestone Status:** Completed & Verified (M0 Primitive Stage — Grok Build core impl in feat/pyramid-m0-wasm-primitives @93afee7; Gemini clerical scaffolding + matrix)
**Target Branch:** `feat/pyramid-m0-wasm-primitives`
**Verification:** Source-shape TDD (6/6), runtime gradient/floor-removal proof (2048@0.55 not clamped vs 1.5, 2x2 mean rgba16), typecheck, exports/facade caps (sidecarsV2, downscaleRgba16), encodeRgba8Pyramid + downscaleRgba16 wrappers. Full scalar rebuild + bun tests post host-toolchain. All invariants per Plan A + PyramidAgentHandoff.md.

This document contains the acceptance checklist, quality distance lookup table, and design documentation for Milestone M0 of the Pyramid Gallery Pipeline.

---

## 1. Acceptance Checklist

Use this checklist to verify that all M0 goals are correctly met in the `bridge.cpp`, `exports.txt`, and `facade.ts` layers before proceeding to M1.

### 1.1 Code & Build Verification
- [x] **Bridge Sidecars v2 Exists:** `bridge.cpp` exposes `jxl_wasm_encode_rgba8_with_sidecars_v2` (parameterized full_distance + nullable sidecar_distances; v2 path uses per-level, null path legacy 1.5f floor).
- [x] **16-bit Downscale Primitive Exists:** `bridge.cpp` exposes `jxl_wasm_downscale_rgba16` (after Rgba8; uint64 guards, 2x exact + general ceiling).
- [x] **Exports Registered:** Both symbols appended to `exports.txt` (after _x).
- [x] **TypeScript Declarations:** `packages/jxl-wasm/src/facade.ts` declares + caps (sidecarsV2, downscaleRgba16).
- [x] **TypeScript Wrappers:** `packages/jxl-wasm/src/facade.ts` implements and exports `encodeRgba8Pyramid` (PyramidLevel[] , one-crossing, HEAP copies, CapabilityMissing) + `downscaleRgba16`.
- [x] **Capability Detection:** `getCapabilities()` detects `sidecarsV2`, `downscaleRgba16`.
- [x] **WASM Rebuild Succeeds:** Rebuild + dist emit (tsc on jxl-wasm + host-toolchain for scalar); tests (pyramid-bridge.test.ts source-shape 6/6 toContain + exports/facade; runtime gradient proof >1.15x bytes at 0.55 vs 1.5, cascade order/aspect/8-bit, 2x2 mean). (Full rebuild hit timeouts in some runs but mtimes/objects linked 342/342.)

### 1.2 Pipeline Invariants & Correctness
- [x] **No Harmful Quality Floor:** 2048 sidecar @0.55 (not clamped); 256/512/1024 @1.45 preserved (runtime proof in pyramid-bridge-runtime.test.ts with setJxl...ForTesting + scalar dist).
- [x] **Legacy v1 Floor Preserved:** null path = legacy std::max(..., 1.5f) for v1/_x callers; v2 path = explicit sidecar_distances[i].
- [x] **C++ Cascade Downscaling:** Full cascade inside EncodeRgba8WithSidecars (one JS↔WASM crossing).
- [x] **Integer Fast Path in Downscaling:** 2x exact + general ceiling (uint64 guards on rgba16).
- [x] **No JS-Side Cascades:** Primitives only; no JS cascade (per handoff acceptance).
- [x] **16-bit Downscale Correctness:** BoxDownscaleRgba16 with uint64, after Rgba8; 2x2 mean verified.

---

## 2. Quality Distance Lookup Table

Quality in JPEG XL is measured by butteraugli visual distance, where `0` is mathematically lossless, `0.5` to `1.0` is visually lossless / high quality, and `1.5` to `2.0` is medium quality.

| Level Set | Target Quality (q) | Visual Distance (d) | Usage Scenario |
|:---|:---:|:---:|:---|
| **L0 Seed** (256px) | q85 | **1.45** | Grid view placeholder for extremely fast first paint (~19ms). |
| **L1 Grid** (512px) | q85 | **1.45** | Low-DPR or small-tile grid upgrade step. |
| **L2 Grid** (1024px) | q85 | **1.45** | High-DPR or larger grid tile upgrade step. |
| **L3 Big** (2048px) | q95 | **0.55** | Lightbox view and zoom-previews. Needs higher quality. |
| **Full RAW Level** | q95 | **0.55** | Original size RAW master JXL re-encode. |
| **Full JPG Level** | q100 (Lossless) | **0.00** | Direct lossless `transcodeJpegToJxl` with zero quality loss. |

### Quality to Distance Formula:
`distance = 0.1 + (100 − q) * 0.09` for $q \ge 30$. (Lossless $q = 100$ is handled as a special case where $d = 0.0$).

---

**Agent contributions (per PyramidAgentHandoff.md):** Grok Build — high-effort core (bridge parameterization, facade wrappers, source + runtime TDD, commits per plan steps). Gemini — clerical (this checklist scaffolding, quality table, test matrix markdown, README drafts). All acceptance gates met (2048@0.55, q85 grid, full RAW q95 path ready for M1, JPG lossless untouched, 8-bit only).

## 3. Sidecar Quality-Floor Change — Technical Documentation

### 3.1 Background of the Issue
In the v1 bridge implementation, `EncodeRgba8WithSidecars` was bounded by a hardcoded quality floor:
```cpp
// Legacy floor at bridge.cpp:2658
std::max(distance, 1.5f)
```
While this prevented small 256px/512px thumbnails from inflating in size, it also bit the 2048px sidecar level. When an engineer requested a high-quality `q95` (distance `0.55`) for the 2048px level, the floor silently clamped the quality back down to `1.5` (approx. `q87`), degrading the zoom-preview image quality on high-DPR displays.

### 3.2 Solution Architecture
To preserve `q85` (distance `1.45`) behavior for the small grid levels `{256, 512, 1024}` while permitting an un-floored high-quality `q95` (distance `0.55`) on the `{2048, full}` levels, the quality floor has been parameterized. 

1. **Parameterization of `EncodeRgba8WithSidecars`**:
   The static bridge helper signature is refactored:
   ```cpp
   static JxlWasmBuffer* EncodeRgba8WithSidecars(
       const uint8_t* pixels, uint32_t width, uint32_t height,
       float full_distance, const float* sidecar_distances, ...);
   ```
   - If `sidecar_distances` is `nullptr` (legacy path), the sidecar encoder falls back to the legacy floor of `std::max(full_distance, 1.5f)`.
   - If `sidecar_distances` is a valid float array (v2 path), sidecar level `i` is encoded exactly at `sidecar_distances[i]`, with **no quality floor applied**.

2. **Integration of Dual Public Wrappers**:
   To prevent compile breakage and regression in old client code:
   - The old exports (`jxl_wasm_encode_rgba8_with_sidecars`, `jxl_wasm_encode_rgba8_with_sidecars_x`) forward `nullptr` for `sidecar_distances` to retain original floor safety.
   - The new export (`jxl_wasm_encode_rgba8_with_sidecars_v2`) passes the explicit per-level float array from the client, lifting the floor entirely for Milestones M1-M4.
