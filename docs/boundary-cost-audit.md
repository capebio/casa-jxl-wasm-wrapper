# Boundary Cost Audit — JXL WASM Pipeline

> **Status**: First sketch (May 2026). Gathered from code inspection of the core WASM pipeline, workers, scheduler/session, and the highest-fidelity timing harness.

**Goal**: Systematically map every place pixel data, compressed data, or metadata crosses a significant boundary in the WASM implementation, estimate the cost, and identify high-leverage reduction opportunities.

**Key Finding (Early)**: For a typical "ingest RAW → produce JXL" workflow exercised in the measurement harness, there are **3–4 full image-sized buffer allocations/copies** before the data even reaches libjxl's encoder. This is one of the largest remaining cost centers after the previous per-pixel fast-path work.

**Current Lens**: Instead of hunting individual hot loops (the previous "fast-path principles" style), we examine *data movement cost* across:
- JS ↔ WASM (via Emscripten HEAP + _malloc/_free)
- Main thread ↔ Worker (structured clone + ArrayBuffer transfer)
- Within WASM (internal malloc vs direct libjxl buffers)
- Application layers (scheduler → handler → facade → bridge)

---

## 1. Major Boundary Categories

### A. JS ↔ WASM Heap Boundary (facade.ts ↔ bridge.cpp)
- Every `_malloc` + `HEAPU8.set(view, ptr)` + eventual `_free`
- `takeBuffer` / `MakeBufferFromOwned` paths that transfer ownership out of WASM
- Direct output buffer registration (`JxlDecoderSetImageOutBuffer`)

**Known hotspots from code**:
- `transcodeJpegToJxl`
- `encodeTiledRgba8` / tiled decode paths
- `marshalAnimationFrames` (per-frame pixel data + names)
- Custom boxes / jumbf / box opts marshaling
- Progressive decode final/progress pixels coming back through facade

**Cost characteristics**:
- Allocation + full copy of the buffer into WASM linear memory
- Later, when returning pixels, often another copy or ownership transfer

### B. Main Thread ↔ Worker Boundary
- `postMessage(msg, [transferList])` — zero-copy when buffers are transferred
- `toArrayBuffer()` helper (decode-handler.ts:526)
  - Sometimes does `value.buffer.slice(...)` → **copy**
  - Sometimes returns the underlying buffer directly (good)

**Observed patterns**:
- Decode: pixels are produced in worker (facade → handler), then transferred to main via scheduler.
- Encode: pixel chunks from main are transferred into worker, then into WASM.
- Scheduler explicitly tracks `transfer: ArrayBuffer[]` arrays.

### C. Scheduler / Session / Handler Internal Queues
- Chunk queues and pixel queues store `ArrayBuffer`s.
- `compactQueue` uses `copyWithin` (no allocation, good).
- Buffering of chunks before they cross into WASM.

### D. RAW Pipeline → JXL Encode Boundary (src/lib.rs)
- `process_orf*` / `process_dng*` etc. return RGB8 or RGB16 buffers.
- These buffers then flow into JXL encode paths (often via facade marshal functions).
- This is a major cross-language + format conversion boundary.

### E. Internal WASM Memory Management (bridge.cpp)
- `pixels_raw` in DecodeRgba (raw malloc, reused/grown)
- `outbuf` growth in encoder
- Gain map bundle allocation
- Animation frame descriptors

---

## 2. Pixel Buffer Lifecycle Traces (Initial)

### Trace 1: Typical Progressive JXL Decode (to main thread)
1. Compressed chunks arrive in worker (ArrayBuffer transfer from main)
2. Chunks copied into WASM heap (`_malloc` + set in facade)
3. libjxl writes decoded pixels into `pixels_raw` (direct, no copy — good)
4. On progress/final: facade wraps pixels → event
5. Handler does `toArrayBuffer(event.pixels)` (possible copy)
6. `postMessage(..., [pixels])` — transfer to main (zero-copy if successful)
7. Scheduler delivers to session → application

**Copies observed**:
- Chunk ingestion into WASM (usually necessary)
- Possible `slice` in `toArrayBuffer`
- Pixel buffer is often the biggest one

### Trace 2: RAW → JXL Encode (common gallery/export path)
1. RAW decode in `src/lib.rs` produces RGB8 / packed RGB16 (new Vec allocations)
2. Data crosses into JS (return from WASM call)
3. JS may hold it as Uint8Array
4. Later: marshal into JXL encode (often another `_malloc` + `HEAPU8.set`)
5. libjxl encode runs
6. Compressed output comes back (another buffer handoff)

**High cost area**: RAW output buffer → JXL input buffer transition.

### Trace 3: Animation Encode
- Per-frame pixel data + names marshaled in `marshalAnimationFrames`
- Multiple `_malloc` + set per frame
- All transferred into WASM at once

This was partially improved with `mallocAndCopy` helper and TextEncoder hoisting during prior work.

---

## 3. Preliminary Cost Observations

| Boundary | Frequency | Typical Copy? | Notes |
|----------|-----------|---------------|-------|
| Chunk → WASM heap (decode) | Per input chunk | Yes (set) | Necessary for libjxl |
| WASM pixels → JS (decode progress/final) | Per emitted frame | Sometimes (toArrayBuffer slice) | Critical for large images |
| Pixels transfer Main ↔ Worker | Per progress/final or chunk | Can be zero-copy (transfer) | Scheduler helps here |
| RAW output (lib.rs) → JXL input | Once per image (or per cache) | Multiple | Big RGB buffers |
| Animation frame marshal | Per frame | Multiple malloc+set | High for long animations |
| Gain map round-trip | Rare | Allocation + copy | Small data |

---

## 4. High-Leverage Opportunity Areas (Early)

1. **Reduce pixel buffer round-trips in decode**  
   Can we keep decoded pixels in WASM memory longer and only ship regions or lower-res versions when needed?

2. **RAW → JXL direct path**  
   Is there a way for the RAW pipeline output to be written directly into a buffer that JXL encode can consume without an extra full copy + malloc in JS?

3. **Batched / arena allocation for animation & sidecars**  
   Instead of N individual mallocs for N frames/boxes, one or two larger allocations.

4. **Make `toArrayBuffer` zero-copy more often**  
   Audit call sites to ensure we pass ownership early so the slice path is avoided.

5. **SharedArrayBuffer for same-thread or COEP-enabled cases**  
   Could eliminate some transfers entirely for certain use cases.

---

## 5. Concrete Trace: RAW Decode → Display / Encode (from web/ and lab code)

Example flow seen in `web/jxl-wrapper-lab.js` and `web/jxl-preset-benchmark.js`:

1. `process_orf(bytes, ...)` (or dng/cr2) in WASM → returns `OrfResult` / similar struct.
2. `result.take_rgb()` → full RGB8 buffer copied out of WASM (new allocation on JS side).
3. `rgb_to_rgba(rgb)` → another full buffer allocation + conversion (explicit in many call sites).
4. The resulting RGBA buffer is then either:
   - Displayed (canvas), or
   - Fed into JXL encode (which will usually do yet another `_malloc` + `HEAPU8.set` in facade when marshaling for `pushPixels` or animation frames).

**Cost**: At least 2–3 full copies of the image-sized buffer for a typical "decode RAW then encode JXL" journey, plus multiple WASM heap round trips.

This is one of the highest-volume boundaries in real usage.

## 6. Refined Cost Table (Updated)

| Boundary | Example Sites | Copy Frequency | Notes / Current Mitigations |
|----------|---------------|----------------|-----------------------------|
| RAW output → JS | `take_rgb()`, `take_rgb16_lb` etc. in lib.rs | Every RAW decode | Returns owned Vec → JS ArrayBuffer view |
| RAW RGB → RGBA | `rgb_to_rgba()` calls in web/ and benchmarks | Very common before JXL encode | Full buffer allocation |
| JS buffer → WASM heap (encode) | `copyOrBorrowInput` + `_malloc`+`set` in facade | Per image / per frame / per chunk | `copy=false` fast path exists when worker has ownership |
| WASM decode pixels → JS | `takeBuffer`, progress/final events in facade | Per emitted frame | Sometimes uses direct ownership transfer |
| Worker → Main pixel transfer | `toArrayBuffer` + `postMessage(..., [pixels])` | Per progress/final | `slice()` copy in some `toArrayBuffer` cases |
| Animation frame marshaling | `marshalAnimationFrames` | Per frame | Multiple malloc+set; partially mitigated by `mallocAndCopy` helper |

## 7. Refined High-Leverage Opportunities

**Tier 1 (High impact, potentially architectural)**
- Create a direct "RAW buffer → JXL encode input" path that minimizes or eliminates the JS-side RGB→RGBA + marshal copies.
- Allow the progressive decoder to hand back pixel regions while keeping the bulk buffer inside WASM (region decode improvements already heading this direction).

**Tier 2 (Good tactical wins)**
- Make `toArrayBuffer` / `exactBuffer` and pixel handoff paths always zero-copy when the worker has exclusive ownership (audit all call sites).
- Extend the arena/batching idea from animation to other multi-buffer encodes (sidecars, custom boxes).
- Explore keeping decoded progressive frames in WASM memory and only shipping downsampled or cropped versions until the user actually needs the full res.

**Tier 3 (Measurement & validation)**
- Add explicit "boundary crossing" metrics (bytes copied across JS↔WASM, number of transfers, etc.) to the existing `onMetric` system so we can quantify before/after.

---

## 8. Specific Trace from Highest-Fidelity Measurement Harness

From `benchmark/session-worker-timings-browser.js` (the code used for `session-worker-timings`):

1. `process_orf_with_flags` / dng / cr2 (with `OUTPUT_FULL_RGB`) → returns result with `take_rgb()`.
2. `rgb_to_rgba(rgb)` → produces the `source.rgba` buffer (full extra allocation + conversion).
3. Later: `session.pushPixels(exactBuffer(source.rgba))` (another potential copy/ownership handoff depending on `exactBuffer` implementation).
4. Inside the session: this eventually reaches the worker → facade marshal → WASM `_malloc` + set for JXL encoding.

This path is exercised in every "Gobabeb" measurement run and represents a very common real-world "ingest RAW → produce JXL" workflow.

**Estimated crossings for one 24MP image on this path**: At least 3–4 full image-sized buffer allocations/copies before the data even reaches libjxl's encoder.

---

## Next Steps

- Trace the actual `encodeWithSession` / `decodeWithSession` code paths used in `benchmark/session-worker-timings-browser.js`.
- Instrument or manually count crossings for a representative 20–50MP RAW encode workload.
- Evaluate feasibility of a "zero-copy RAW to JXL" bridge extension.

*Living document — updated during the 2026 optimization campaign.*

**Handoff Note**: A detailed continuation handoff exists at `docs/HANDOFF-boundary-cost-audit-2026.md`. Start there for full context when resuming in a fresh session.

---

## 9. Execution Plan: Attack the RAW → JXL Boundary (Phase 2)

**Strategic Objective**: Significantly reduce the number of full image-sized buffer copies when going from RAW decode to JXL encode — the highest-cost boundary identified in this audit.

### Phased Approach

**Phase 2A – Direct RGBA8 Output from RAW Pipeline (High confidence, medium effort)**
- Add support for emitting RGBA8 directly from `process_orf*`, `process_dng*`, `process_cr2*` (and their `_with_flags` variants).
- Add `take_rgba()` / `take_rgba8()` methods on the result structs.
- Update `rgb_to_rgba` callers in benchmarks and web code to use the new direct path where possible.
- Expected impact: Eliminates one full buffer allocation + conversion per image in the common "decode RAW → encode JXL" path.

**Phase 2B – Zero-Copy / View-Friendly Output (Higher effort)**
- Explore exposing WASM memory views or direct pointers for the output buffers so JXL encoding can consume them with minimal or zero additional copies across the JS/WASM boundary.
- This may require new bridge functions or changes to how `ProcessResult` exposes data.

**Phase 2C – Measurement & Validation**
- Add boundary-crossing metrics to the timing harnesses.
- Run before/after comparisons on representative workloads (20MP+ RAW files, batch processing).

### Immediate Next Actions (Starting Now)
1. ~~Extend the output flag system or add dedicated RGBA paths in `src/lib.rs`.~~ (Done via `take_rgba()` / `rgba()` methods)
2. ~~Implement `take_rgba()` on the result types.~~ (Done)
3. ~~Update the most important call sites in the benchmark harnesses to use the new direct path.~~ (Partially done in `session-worker-timings-browser.js`, `targeted-wasm-timings.mjs`, `encode-option-sweep.mjs`)
4. Verify no regression in existing RGB-only paths. (Compiles cleanly)
5. Update `docs/boundary-cost-audit.md` with measured impact. (In progress)

**Status as of this update**: Basic direct RGBA path (`take_rgba()` / `rgba()`) is implemented in `src/lib.rs` and rolled out (with fallback) to the primary measurement harnesses. This is the first concrete code change from the Boundary Cost Audit. Next steps are broader rollout, potential internal RGBA production, and measurement of actual savings.

Priority: Phase 2A first — it gives the best risk/reward and directly attacks the #1 cost center identified.
- Measure (or estimate) buffer sizes and crossing frequency for a 20MP RAW → JXL encode.
- Look for places where we currently copy "just in case" that could use views + careful ownership.
- Compare against the scheduler's existing transfer list discipline.

---

## 10. Phase 2A Follow-up: Wider Rollout + Owned-Vec RGBA Expansion

**Implementation update (June 2026)**:
- `ProcessResult::take_rgba()` now consumes the owned RGB `Vec<u8>` and expands it backward into RGBA8 instead of allocating a separate RGBA `Vec` from a borrowed RGB slice.
- The fallback `rgb_to_rgba(&[u8])` path remains unchanged for JS callers and `ProcessResult::rgba()`.
- More hot call sites now prefer `take_rgba()` when they do not need to retain RGB:
  - `benchmark/raw-format-sweep.mjs`
  - `web/jxl-wrapper-lab.js`
  - `web/jxl-benchmark.js`
  - `web/jxl-preset-benchmark.js`
  - `web/jxl-crop-benchmark.js`
  - `web/jxl-progressive-paint.js`
  - `web/icodec-jxl-worker.test.js`
  - `web/worker.js` for the no-user-rotation encode path

**Boundary effect**:
- Old common path: return RGB to JS (`3 * pixels`), allocate/write RGBA in JS (`4 * pixels`), then marshal RGBA into encoder.
- New `take_rgba()` path: expand RGB to RGBA inside WASM and return only RGBA (`4 * pixels`) to JS.
- For a 20MP image, this avoids about 57.2 MiB of RGB JS handoff plus a 76.3 MiB JS RGBA allocation/write in no-RGB-needed paths.
- For a 24MP image, this avoids about 68.7 MiB of RGB JS handoff plus a 91.6 MiB JS RGBA allocation/write.
- The owned-Vec expansion also avoids holding a second full RGBA allocation inside Rust for `take_rgba()`; allocator reallocation may still move the buffer if RGB capacity cannot grow in place.

**Measurement fields added**:
- `rgbaPrepMode`: `"wasm-take-rgba"` or `"js-rgb-to-rgba"`
- `rawRgbBytes`: `width * height * 3`
- `rgbaBytes`: `width * height * 4`

These fields are emitted by the high-fidelity session worker and targeted timing artifacts so future runs can separate true timing changes from path-selection changes.

**Deferred by design**:
- Call sites that intentionally keep RGB and RGBA (for comparison, source caches, or RGB-specific tests) were not changed. Using `take_rgba()` there would either consume RGB or require a second conversion, increasing memory traffic.
- Direct RAW-stage RGBA production was not attempted here. It may save more allocator churn, but it changes output ownership and stage accounting more deeply than this surgical Phase 2A pass.

**Next candidate**:
- Audit `web/worker.js` rotated encode path and RGB-retaining lab/progressive sources. If those paths can encode from transient RGBA while retaining RGB only when the UI actually needs it, the next win is another full-buffer lifetime reduction rather than a faster conversion loop.

## 11. A/B Measurement Setup

The timing harnesses now accept `RAW_RGBA_MODE`:
- `RAW_RGBA_MODE=js`: force the old A-baseline path, `take_rgb()` followed by `rgb_to_rgba()`.
- `RAW_RGBA_MODE=take`: force Option A, `take_rgba()`.
- `RAW_RGBA_MODE=direct`: reserved for Option B. It fails loudly unless a future build exports `take_rgba_direct()`.

Recommended tiny smoke comparison after rebuilding `pkg/`:

```powershell
cmd /c "set RAW_RGBA_MODE=js&& set TEST_RUNS=1&& set TEST_SCAN_LIMIT=1&& set GOB_SCAN_LIMIT=0&& set GOB_OFFENDER_COUNT=0&& set GOB_OFFENDER_RUNS=0&& node benchmark\targeted-wasm-timings.mjs"
cmd /c "set RAW_RGBA_MODE=take&& set TEST_RUNS=1&& set TEST_SCAN_LIMIT=1&& set GOB_SCAN_LIMIT=0&& set GOB_OFFENDER_COUNT=0&& set GOB_OFFENDER_RUNS=0&& node benchmark\targeted-wasm-timings.mjs"
```

**Fix applied before measurement**:
- The Node targeted harness was blocked by a bounds panic in `raw_pipeline::pipeline::process` in the non-parallel WASM path.
- Root cause: the non-parallel loop indexed the 65,536-entry post-tone LUT with `pre_lut_value * 255`, producing indices up to about 16M. It also skipped the matrix/saturation/vibrance math used by the parallel path.
- The workspace now uses a local `crates/raw-pipeline` copy with the non-parallel loop corrected to mirror the parallel path and clamp post-LUT indices to `0..=65535`.

**Measured A comparison (targeted Node harness, `_MG_1744.CR2`, 5184x3456, `TEST_RUNS=3`, `TEST_SCAN_LIMIT=1`)**:

| Mode | Prep median | Raw wall median | Encode median | Decode median | Total median |
|------|-------------|-----------------|---------------|---------------|--------------|
| `RAW_RGBA_MODE=js` | 92.4 ms | 1297.7 ms | 3375.4 ms | 3081.3 ms | 7846.8 ms |
| `RAW_RGBA_MODE=take` | 70.2 ms | 1219.4 ms | 3407.9 ms | 2892.5 ms | 7590.0 ms |

Interpretation:
- `take_rgba()` saved 22.2 ms in RGBA prep on this run (~24% lower prep time).
- End-to-end median improved by 256.8 ms (~3.3%), though encode/decode noise is large enough that more files/runs are needed before treating total delta as stable.
- This supports keeping Option A while building Option B only if larger multi-file runs show prep/peak memory remains worth targeting.

**Next fair B sequence**:
1. Add `process_rgba()` / direct RGBA output in `crates/raw-pipeline`.
2. Expose that as `take_rgba_direct()` or an RGBA output flag in `ProcessResult`.
3. Run `RAW_RGBA_MODE=js`, `RAW_RGBA_MODE=take`, and `RAW_RGBA_MODE=direct` over the same file set.

*This document is a living sketch started during the 2026 WASM optimization campaign.*
