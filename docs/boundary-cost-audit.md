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

---

## 12. Fresh 2026-06 Browser/WASM Measurements (High-Fidelity Session Pipeline)

Real end-to-end numbers from the actual browser harness (`session-worker-timings-browser.js` + Playwright + real `pkg/raw_converter_wasm_bg.wasm`) on the same 24 MP CR2 used in earlier Node-targeted data (`_MG_1744.CR2`, 5184×3456).

**Single-run comparison (TEST_RUNS=1, TEST_SCAN_LIMIT=1, no Gob data):**

| Mode              | rgbaPrepMs | rawWall | encode  | decode  | total   | rgbaPrepMode     | Notes |
|-------------------|------------|---------|---------|---------|---------|------------------|-------|
| `js-rgb-to-rgba`  | **210.3**  | 5347    | 9762    | 8095    | 23414   | baseline         | take_rgb + pure JS conversion |
| `wasm-take-rgba`  | 323.6      | 5349    | 9710    | 7903    | **23286** | Phase 2A         | single take_rgba() call |

**Key observations from the real WASM/browser path:**
- Prep time for the current WASM `take_rgba` path was **~113 ms worse** than the JS conversion path in this run.
- Downstream (encode + decode) was ~245 ms faster, producing a net **~128 ms / ~0.55%** win on total time.
- This is the opposite prep delta from the earlier Node-targeted harness (where `take` saved 22 ms / 24% on prep).
- The user's prior observation ("on Wasm the take seemed to be best by a few well-earned percentage") is consistent with the small net end-to-end win, even when the isolated prep number regressed.
- The cost of moving the conversion across the WASM boundary is not a pure win; it trades JS allocation/GC for WASM→JS return of a larger buffer + different allocator behavior in the Rust side.

**Follow-up change performed (surgical):**
- Simplified `ProcessResult::take_rgba()` in `src/lib.rs` to simply `rgb_to_rgba(&std::mem::take(&mut self.rgb))`.
- Removed the previous complex `rgb_vec_to_rgba_in_place` backward-resize strategy (which was intended to minimize Rust-side allocations but produced a cache-unfriendly loop).
- The new path re-uses the exact tight forward loop that was already winning in the JS measurement. Cargo check for `wasm32-unknown-unknown` passes cleanly.
- This is the minimal change that keeps the ownership benefit (no extra 3× RGB buffer retained in JS for pure-encode paths) while using the proven conversion code.

**Revised guidance on Phase 2B (direct RGBA production inside raw-pipeline):**
- Lower priority until the current WASM conversion path is at least competitive on prep time with the pure-JS path in the browser harness.
- The fact that even "move the work into WASM" showed a prep regression in the real pipeline suggests the dominant costs may now be in the return/transfer/ownership handoff of the larger RGBA buffer itself, not the conversion arithmetic.
- Direct production inside the tone loop (Phase 2B) would eliminate one more Vec, but would also require maintaining two hot inner loops (or a format flag) and would change output ownership for every consumer of the RAW pipeline (LookRenderer, thumbs, lightbox, caches, rotation paths). The risk/reward is poorer until we have data showing the current Phase 2A path is leaving meaningful prep time on the table after the simplification above.
- The legitimate "must retain RGB" case in `web/worker.js` (userRotation path that goes through `rotate_rgb8`) continues to use the old pattern by design.

**Next recommended actions (pre-30-file run):**
1. Re-run the browser harness with the simplified `take_rgba` (after a `wasm-pack build` if needed for the running `pkg/`) to see whether prep time improved.
2. If prep remains higher for the WASM path, instrument or profile where the time is actually going (wasm-bindgen return copy, `exactBuffer` slice on the 4× buffer, later pushPixels transfer, etc.).
3. Consider a tiny `rgb_to_rgba_in_wasm` helper that the rotation path in worker.js can use after `rotate_rgb8` so rotated encodes also get the ownership benefit without a second conversion.
4. Only after the above, re-evaluate whether a true direct-RGBA flag in the raw pipeline (Phase 2B) is justified.

### 12.1 30-File Gobabeb Verification (June 2026) — Stronger Evidence

**Setup**: Same high-fidelity browser/WASM harness (`session-worker-timings-browser.js` + real WASM + Playwright Chromium with COOP/COEP). 30 distinct Olympus ORF files from the Gobabeb collection (`C:\995\2026-02-20 Gobabeb To Windhoek`), all ~5240×3912, 16.5–17.5 MB. `GOB_SCAN_LIMIT=30`, `TEST_RUNS=1`, `TEST_SCAN_LIMIT=0`, `GOB_OFFENDER_*=0`, headless. Runs executed back-to-back on the same machine.

**Artifacts**:
- JS baseline: `benchmark\runs\session-worker-timings-2026-06-01T21-08-23-919Z.json`
- take Phase 2A: `benchmark\runs\session-worker-timings-2026-06-01T21-11-27-075Z.json`

**Results (30 common files, perfect overlap)**:

| Metric                  | JS baseline (take_rgb + rgb_to_rgba) | take Phase 2A (`take_rgba`) | Delta (take − js) |
|-------------------------|--------------------------------------|-----------------------------|-------------------|
| rgbaPrepMs (mean)       | 64.9 ms                              | 75.3 ms                     | **+10.5 ms**      |
| rgbaPrepMs (median)     | 62.2 ms                              | 73.5 ms                     | **+13.0 ms** (paired median) |
| Total time (mean)       | ~5452 ms                             | ~5712 ms                    | **+260 ms**       |
| Files where take won on prep | —                                    | —                           | **2 / 30**        |

**Paired per-file prepDelta distribution**:
- Mean: +10.5 ms
- Median: +13.0 ms
- Range: −47.7 ms … +40.1 ms
- Only 2 files showed a prep win for `take_rgba`; the large majority favored the JS conversion path.

**Interpretation**:
- On this real-world Gobabeb dataset (the highest-fidelity "ON Wasm" measurement the project has), the current `take_rgba` implementation is a **clear net regression** for browser usage: ~+10–13 ms worse RGBA prep on average, translating to ~+230–260 ms slower end-to-end per file (~4–5% slower total).
- This is consistent with (and stronger than) the earlier single-file browser run.
- The earlier Node-targeted harness had shown a win for `take`; the boundary cost picture is environment- and harness-specific.
- The simplification performed earlier (delegating to the proven `rgb_to_rgba` loop) did not reverse the regression in the browser path.

**Implications for rollout and Phase 2B**:
- For pure browser/WASM gallery/export/lightbox encode flows that dominate real usage of this pipeline, the JS `rgb_to_rgba` + `take_rgb` path is currently the faster, lower-risk choice.
- The ownership benefit of `take_rgba` (avoiding a retained 3× RGB buffer in JS) does not outweigh the measured cost in this environment.
- Phase 2B (direct RGBA production inside `crates/raw-pipeline`) has even less justification on current data — it would be optimizing the wrong side of a boundary that is already favoring staying in JS for the conversion step.
- The rotation path in `web/worker.js` (which legitimately must take RGB) continues to use the JS conversion and is not disadvantaged.

**Recommended immediate posture**:
- Keep the safe fallback code (`typeof result.take_rgba === 'function' ? result.take_rgba() : rgb_to_rgba(...)`) everywhere it already exists.
- For new or hot browser paths, prefer the JS conversion path unless/until a future improvement makes the WASM-side RGBA path competitive on prep time in the session harness.
- Any future work on "direct" RGBA should be gated behind first making the current `take_rgba` path at least parity on prep in the browser harness on Gobabeb-scale data.

This 30-file result is the strongest evidence yet on the actual cost of the RAW → JXL boundary in the environment that matters most for the project.

### 12.2 Final Profiling Round + Decision (June 2026)

After the 30-file verification, we added two new cheap JS-side handoff timings to the harness (`postRgbaPrepMs` and `rgbaExactBufferMs`) and re-ran the full 30-file Gobabeb set in both modes.

**New timing results** (30 Gobabeb ORFs, browser + real WASM):
- `postRgbaPrepMs` (resize + immediate work after `takeRgbaForMode`): ~0 ms in both paths.
- `rgbaExactBufferMs` (`exactBuffer(source.rgba)` right before `pushPixels`): ~0 ms in both paths.

**Interpretation**: The larger 4× RGBA buffer created by `take_rgba()` creates **no measurable extra cost** in the post-prep handoff or `exactBuffer` step for these workloads. All of the regression lives inside the `rgbaPrepMs` window (the WASM call + glue copy-out of the ~76 MiB buffer).

This completed the measurement campaign for this boundary. Combined with the earlier fine-grained `rgbaPrepBreakdown` data, we have high-confidence evidence that the current WASM-side conversion is slower than the JS path in the actual browser environment.

**Decision recorded in `docs/suggested-settings.md`**:
- For browser/WASM paths, prefer the JS conversion after `take_rgb()`.
- Keep the safe fallback pattern everywhere it already exists.
- Future "direct RGBA" work (Phase 2B) should be gated behind first making the WASM path competitive on browser prep metrics.

See the new canonical document `docs/suggested-settings.md` for the full recommendation, the analysis of "what we actually lose if we remove `take_rgba()`/`rgba()`", and the net assessment.

*Living document — final writeup + suggested-settings document created, June 2026.*

## 13. Decode Pixel Handoff — Crop Benchmark Multi-File Data (June 2026)

**Dataset**: 11 files (P2200xxx.ORF series, herbarium/sky/plant content), tile=128px, 5 crop sizes (128-2048px), 55 samples. Single-file runs with different tile sizes showed consistent patterns.

**High-level (per-size averages across files)**:
- Full decode + JS crop: ~2.5-2.9s, relatively flat (content variance 2.2-3.8s per file).
- Tile region decode: 1.2-2.7s, high even for small crops, scales up.
- JXTC ROI decode: 9-15ms at 128px, scaling to 500-870ms at 2048px. Best for small/medium views.
- Tile vs Full speedup: 2.1x at small → 1.2x at large. JXTC wins bigger at small sizes.

**Decode Pixel Handoff Metrics (the boundary costs)**:
- buffer_extract avg: 3.8 ms (0.1-12ms per sample, scales mildly with crop size). Captures WASM buffer extraction/ownership handoff (via tiled buffer_read mapping for region paths + full decode time proxy for baseline).
- region_downsample avg: 542 ms (344-912ms, scales with size). Captures the decode work for the region (mostly from tiled wasm_decode costs in the "smart" paths; tile path has higher internal decode even for small crops).
- toarraybuffer: — (not exercised; this benchmark uses direct createDecoder in page, not worker + DecodeHandler).

**Per-file variance**: Noticeable (some files 2200ms full, others 3800ms+ on mid crops; region costs vary 350-900ms). Consistent pattern: buffer_extract cheap; region work dominates variable cost in smart paths; JXTC << Tile for small crops.

**Key insights for the boundary**:
- The pixel handoff/extract part (facade slice + ownership transfer out of WASM for region output) is **cheap** (~few ms). "Keeping bulk in WASM" + transfer is efficient. Not the bottleneck.
- The expensive part in region decode is the actual WASM decode work for the requested region (hundreds of ms, scales with output size). JXTC minimizes this by only decoding needed tiles; standard "region" in progressive still pays more (post-decode JS crop after full WASM decode in progressive path).
- Tile path has ~1.1-1.5s overhead beyond the region decode work (tile management).
- Full file load (~2.5-3s) is the fixed cost of full WASM decode + extract + JS crop. Even with `region` set in standard decoder (progressive path), it decodes full then crops in JS (see facade eventsProgressive + takeAndWrap + applyRegionAndDownsample; C++ early crop is in oneShot path).
- toArrayBuffer (handler defensive copy before postMessage) not visible here.

**Actionables for improved timings (focus on long full file load)**:
1. **For crops/thumbnails in main UI (lightbox, worker.js, etc.)**: Default to JXTC or tiled region decode when available (images encoded with tile bridge). This avoids the full decode tax. The crop benchmark shows 10-50x wins for small crops.
2. **For full resolution loads**: Use progressive decode with `emitEveryPass: true` or low `progressionTarget` ("dc" or "pass") + onMetric to show low-res quickly, then refine. Reduces *perceived* load time for full files (the 2-3s is mostly WASM decode work).
3. **Improve standard decoder region for progressive**: Currently, progressive + region = full WASM decode then JS crop (see eventsProgressive + takeAndWrap). Add early crop support (pass region to dec state, or use oneShot for crops if C++ region available). See facade: cppDidCrop only in oneShot/callDecodeFromPtr.
4. **Reduce tile path overhead**: The ~1.2s extra in "Tile" vs its region decode cost is in tile grid/assembly. Profile the tiled decode in facade (decodeTiledRegionRgba8) and bridge for small crop cases.
5. **Further analysis to tackle costs**:
   - Run the crop benchmark through full jxl-session/scheduler/worker path (modify to use session for decodes) to capture `toarraybuffer` cost + scheduler overhead on pixel transfers. This will show the handler boundary cost.
   - Enhance decodeFullThenCrop (and main full decode) to break down: time create/push/events separately; capture all decoder onMetric (source_pixels_decoded will confirm full size work; decode_scale_used, etc.). The added full_decoder_* timings will help in next runs.
   - Add progressive mode to the crop benchmark (emitEveryPass=true) to measure handoff costs on DC/pass.
   - For full file: default to downsample=2 or 4 for initial view, then refine on demand.
   - Look at per-file variance: correlate with image content/size (some files pay more in full/region).
   - If buffer_extract ever grows (larger regions), consider direct views instead of slice in readBufferView for owned buffers.

**Suggested settings update**: In main decode paths, for region/crop requests prefer efficient paths (JXTC/tiled); for full use progressive to hide latency. The handoff extract is not the win; avoiding unnecessary decode work is.

This data (plus smaller runs) confirms the boundary: extract cheap, savings in smart decode. The "one more" report should have similar or the worker path data.

*Living document — decode side crop benchmark analysis added, June 2026.*

**P3.3 close-out (this session)**: Useful remaining parts completed before commit:
- `docs/suggested-settings.md` extended with "Decode Strategy (Region/Crop vs Full Loads)" section recording the exact recommendations from the 11-file data + actionable list.
- Light exposure/comments added in main production decode paths (`web/jxl-decode-worker.js:decodeProgressive`, `web/jxl-progressive.js:streamDecodeJxlSession`) so the JXTC-for-crops / progressive-for-full preference is visible at the call sites without changing behavior.
- Confirmed: crop benchmark self-describes with Decode Pixel Handoff + full_decoder_* breakdowns in Copy MD/JSON; progressive paths already use emitEveryPass for full loads; no further dataset run needed per prior user note.
- Audit §13 + suggested-settings now form the complete record for the decode/region boundary. Next: commit/push, then Tauri/WASM parity handoff doc.

See also the Tauri handoff for how native should approach region/ROI and progressive to achieve (or beat) these timings without JS/WASM boundaries.

**Post-handoff (Tauri parity implementation)**: The core of 4.1 (direct-RGBA) from the Tauri handoff was implemented here:
- Added `pipeline::process_rgba` (fused tone→RGBA8, parallel+serial paths, shared math helper) + `encode_variants_from_rgb16` in `crates/raw-pipeline` (and vendor snapshot).
- `raw_decode_bench` now measures head-to-head (directRgbaMs) and drives its JXL encode timing through the 4ch direct path (no 3ch intermediate for the "encode-only" measurement).
- Smoke tests + WASM crate test ensure linkage.
- `docs/suggested-settings.md` gained a full "Native / Tauri Preferences" section recording the opposite rule from browser (prefer direct rgba for encode flows) + guidance for progressive/ROI/JXTC parity (P3.1–P3.3) on the desktop side.
- No changes to WASM call sites or ProcessResult (per browser preference after 30-file data).
- JXTC/tiled/region decode (P3.3) and true progressive (P3.1) for Tauri lightbox remain Tauri-app specific (use jpegxl-sys low-level + JxlDecoderSetCropEnabled etc.); the shared pipeline piece (encode side) and measurement harness are now in place for parity verification on Gobabeb/P2200 sets. Update audit with native numbers once Tauri runs are captured.

## 14. Progressive Encode Boundary (GroupOrder + multi-DC) — 2026-06 predator note

**Cost of JXL_ENC_FRAME_SETTING_GROUP_ORDER (and progressiveDc=2)**: Negligible. Single `JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_GROUP_ORDER, 1)` call (int64) per encode, done once in the three configure sites in bridge.cpp right after the PROGRESSIVE_DC/AC sets. No extra mallocs, no per-pixel work, no change to buffering or chunking paths. Same for Dc=2 (already wired).

**Observed decode-side effects**: None negative. The option only affects the *codestream structure* produced by libjxl (center-first DC blocks + more DC layers). Decode machinery (JxlDecoderSetProgressiveDetail(kPasses), FRAME_PROGRESSION flushes, facade progressive event yield) is unchanged in cost per surfaced pass. Result: more distinct 'progress' events surface earlier with recognizable content (center bias), which is the entire point. No extra WASM/JS boundary crossings; the extra events are just more frequent small pixel handoffs (same per-event cost).

**Data (from progressive-detail.test.ts roundtrip with Dc=2 + group=1 + preview + passes + noise source)**: encode produces codestream that yields header + >=1 'progress' + final (total events >=3). Test now asserts this. Prior hard-coded Dc=1 produced minimal (often 2 total) events regardless of decoder detail.

**Recommendation**: Always use groupOrder=1 + progressiveDc=2 (when progressive) for any demo/benchmark path that wants "early usable" layers (paint 4/6/8 pass cases, gallery onfly). Cost is zero; win is large for perceived progressive quality. See HANDOFF and progressive-encode-options design note for UI + settings.

*Living — added per predator progressive handoff. Full page A/B numbers (paint 6-pass first-recognizable ms/KB with group=0 vs 1) to be captured on next serve + eyeball.*
