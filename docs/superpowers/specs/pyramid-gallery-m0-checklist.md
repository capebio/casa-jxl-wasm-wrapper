# Milestone M0: WASM Bridge Primitives — Verification Checklist

**Milestone Status:** Approved & Verified (M0 Primitive Stage)
**Target Branch:** `feat/pyramid-m0-wasm-primitives`

This document contains the acceptance checklist, quality distance lookup table, and design documentation for Milestone M0 of the Pyramid Gallery Pipeline.

---

## 1. Acceptance Checklist

Use this checklist to verify that all M0 goals are correctly met in the `bridge.cpp`, `exports.txt`, and `facade.ts` layers before proceeding to M1.

### 1.1 Code & Build Verification
- [ ] **Bridge Sidecars v2 Exists:** `bridge.cpp` exposes `jxl_wasm_encode_rgba8_with_sidecars_v2`.
- [ ] **16-bit Downscale Primitive Exists:** `bridge.cpp` exposes `jxl_wasm_downscale_rgba16`.
- [ ] **Exports Registered:** Both symbols are appended to `exports.txt` with their leading underscores:
  - `_jxl_wasm_encode_rgba8_with_sidecars_v2`
  - `_jxl_wasm_downscale_rgba16`
- [ ] **TypeScript Declarations:** `packages/jxl-wasm/src/facade.ts` declares:
  - `_jxl_wasm_encode_rgba8_with_sidecars_v2?`
  - `_jxl_wasm_downscale_rgba16?`
- [ ] **TypeScript Wrappers:** `packages/jxl-wasm/src/facade.ts` implements and exports:
  - `encodeRgba8Pyramid()`
  - `downscaleRgba16()`
- [ ] **Capability Detection:** `getCapabilities()` in `facade.ts` detects and returns:
  - `sidecarsV2`
  - `downscaleRgba16`
- [ ] **WASM Rebuild Succeeds:** Emscripten compilation succeeds for all tiers without warning or error, producing:
  - `dist/jxl-core.scalar.js` / `dist/jxl-core.scalar.wasm`
  - `dist/jxl-core.simd.js` / `dist/jxl-core.simd.wasm`
  - `dist/jxl-core.simd-mt.js` / `dist/jxl-core.simd-mt.wasm`
  - `dist/jxl-core.relaxed-simd-mt.js` / `dist/jxl-core.relaxed-simd-mt.wasm`

### 1.2 Pipeline Invariants & Correctness
- [ ] **No Harmful Quality Floor:** The 2048 level sidecar is NOT clamped back to distance `1.5` (~q87) but is allowed to encode at the requested `0.55` (~q95) in `jxl_wasm_encode_rgba8_with_sidecars_v2`.
- [ ] **Legacy v1 Floor Preserved:** When calling the original `jxl_wasm_encode_rgba8_with_sidecars` or `_x`, sidecar distances still default to `std::max(full_distance, 1.5f)` when null, preventing regressions for legacy callers.
- [ ] **C++ Cascade Downscaling:** Downscaling of sidecars happens entirely within C++ inside `EncodeRgba8WithSidecars` using area-average box filter cascading (smallest-from-previous), preventing multiple boundary crossings.
- [ ] **Integer Fast Path in Downscaling:** Integer division fast path is utilized on exact 2× steps, and ceiling-division full-coverage is utilized otherwise.
- [ ] **No JS-Side Cascades:** No JS-side resize, canvas drawing, or recursive downscaling is introduced for building the 8-bit pyramid.
- [ ] **16-bit Downscale Correctness:** `BoxDownscaleRgba16` handles 4-channel interleaved `uint16_t` buffers with `uint64_t` accumulators to prevent overflow on massive downscaling, and includes guards for null/zero dimensions.

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
