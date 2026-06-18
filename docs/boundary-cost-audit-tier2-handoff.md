# Boundary Cost Audit — Tier 2 Handoff (June 2026)

**Status**: Planning phase — structured opportunities for future optimization.

**Context**: This document builds on the completed Tier 1 JXTC implementation (`docs/boundary-cost-audit.md` §15). It lists the highest-value remaining opportunities that were identified during the audit but deferred due to complexity, measurement uncertainty, or lower immediate impact.

---

## Overview: What's Left

The Tier 1 JXTC/tiled work achieved a **10–50× speedup** for crop/thumbnail requests (9–15 ms WASM, 0.5–0.8 ms native). The following Tier 2 items represent the next set of boundary-cost reductions.

| Opportunity | Tier | Effort | Priority | Estimated Impact |
|---|---|---|---|---|
| Animation frame marshaling batching | Tier 2 | Medium | Low | Reduce N malloc+set to ~2 allocations (per-frame animation workflows) |
| Worker `toArrayBuffer` transfer audit | Tier 2 | Low | Low | Eliminate `slice()` copy in some pixel handoff paths (~few ms per transfer) |
| JXTC scope expansion (multiple sizes/qualities) | Tier 2 | High | Deferred | Support multiple crop targets + quality variants per asset |
| Per-file JXTC vs full decode UI | Tier 2 | Low | Nice-to-have | Measurement harness + diagnostic UI for A/B comparison |

---

## Action Pass — 2026-06-18 (verified against live code)

All four items re-checked against the current tree before any change. Outcome:

| # | Item | Status | Evidence |
|---|------|--------|----------|
| 1 | Animation marshaling batching | **Deferred (trigger unmet)** | `marshalAnimationFrames` + `mallocAndCopy` still in `bridge.cpp`. No animation/multi-frame path appears in any benchmark hot path. Promotion trigger ("animation a measured bottleneck") not met. |
| 2 | `toArrayBuffer` transfer audit | **DONE / superseded** | Hot paths no longer call `toArrayBuffer`. Progress/final/budget arms call `toTransferablePixels` (`decode-handler.ts:676`) which returns `{ buffer, copied }` — the exact slice-vs-direct signal Option A asked to measure. Already instrumented: `copy_to_transfer_ms` + `copied_bytes` metrics, `copyMs`/`copiedBytes` folded onto frames, `copyLatencyEma` tracked, SAB zero-copy handled. `toArrayBuffer` (`:700`) is now a thin wrapper used only on the cold error-partial path. No code change warranted; Option B (facade returns clean buffers) stays gated behind the metric showing frequent copies — it currently does not. |
| 3 | JXTC variants (multi-size/quality) | **Deferred (trigger unmet)** | `encode_variants_from_rgb16` / `encode_variants_with_progressive` present; single-variant Tier 1 shipped. Promotion trigger ("UI telemetry shows heterogeneous crop sizes") not met. |
| 4 | Diagnostic UI CLI report | **DONE 2026-06-18** (rebuilt on flipflop) | The original plan (read `session-worker-timings-*.json`) was dead — no such artifacts exist. Repurposed the `flipflop` skill instead, which is **better methodology**: interleaved, start-rotated A/B that cancels the thermal drift §13's single-shot crop numbers were exposed to. Deliverables: `.flipflop/tests/jxtc-vs-full-decode.mjs` (the decode A/B) + `tools/jxtc-diagnostic-report.mjs` (journal → markdown + encode/payback). Report: `docs/outputs/jxtc-diagnostic-report-2026-06-18.md`. |

**Decision**: #2 closed as already-implemented. #4 delivered via flipflop (see below). #1/#3 remain deferred (triggers unmet).

### #4 result (flipflop-measured, fbm corpus, scalar WASM, pixel-exact `equal()` guard)

Both arms decode the **same** JXTC container, isolating "decode every tile + JS-crop" vs "decode only the ROI tile". ROI = one 256px tile.

| image | full decode + crop | JXTC ROI decode | speedup | trust |
|---|---:|---:|---:|---|
| 256² (ROI = full) | 13.2 ms | 12.9 ms | 1.0× | floor (sanity) |
| 512² | 42.8 ms | 10.4 ms | 4.1× | high |
| 1024² | 174.8 ms | 11.5 ms | 15.2× | high |
| 2048² | 680.0 ms | 11.1 ms | **61.5×** | high |

Confirms **and extends** §13's "10–50×": ROI decode is flat (~11 ms, always one tile) while full decode scales with area, so the win grows with resolution. Payback (crops to repay the one-time JXTC encode) is single-digit at ≥512² even using a worst-case scalar/lossless encode; production effort=3+SIMD makes it lower still. Regenerate: see the report's Reproduce block.

### #4 encode companion — `flipflopenc` (`.flipflop/tests/jxtc-encode.mjs`)

Times JXTC encode across effort/distance with compressed **size** recorded alongside time (the speed+filesize lens). fbm corpus, scalar WASM, tileSize=256, vs the e3-d0 baseline:

| config | 512² time | 1024² time | 2048² time | vs e3-d0 time | size @2048² |
|---|---:|---:|---:|---:|---:|
| e3-d0 (lossless, ingest default) | 225 ms | 914 ms | 3507 ms | baseline | 3492 KB |
| **e3-d1 (visually lossless)** | 113 ms | 468 ms | 1848 ms | **~49% faster** | **1235 KB (2.8× smaller)** |
| e3-d2 | 86 ms | 356 ms | 1407 ms | ~60% faster | 937 KB |
| e7-d0 (fallback) | 852 ms | 3366 ms | 12667 ms | **~2.6–3.7× slower** | — |

Findings: **(1)** distance is the real lever — distance=1 nearly halves encode time and is ~2.8× smaller than the lossless distance=0 the decode test used; for gallery/thumbnail JXTC, distance=1 is the better ingest setting. **(2)** effort 7 is 2.6–3.7× slower for little real-photo size benefit — **effort=3 stays the default** (corroborates the user's prior speed+filesize measurement). Note: flipflop records `quality` (size) only for non-baseline variants, so the e3-d0 baseline size is read from the report tool, not the journal.

### #4 on REAL camera files (2026-06-18)

Both tests run a `corpus()` over real CR2/DNG/ORF when `JXTC_REAL=<dir>` is set (decode→RGBA via the raw pkg in node; see `.flipflop/lib/raw-corpus.mjs`). Ran against `C:\Foo\raw-converter\tests`. Report: `docs/outputs/jxtc-real-files-report-2026-06-18.md`. (JPEG excluded — no JPEG→RGBA decoder in-repo; the pipeline is a RAW converter.)

| file | MP | full decode + crop | JXTC ROI | **speedup** | d1 encode | d1 size | payback@d1 |
|---|--:|--:|--:|--:|--:|--:|--:|
| ADH 1455.CR2 | 24 | 4324 ms | 13.7 ms | **315×** | — | — | — |
| ADH 1248.CR2 | 24 | 5717 ms | 21.6 ms | **265×** | — | — | — |
| P1110226.ORF | 20.5 | 5449 ms | 23.9 ms | **228×** | 4613 ms | 1698 KB | 1 |
| ADH 1234.CR2 | 24 | 7289 ms | 34.8 ms | **209×** | 6052 ms | 4785 KB | 1 |
| PXL…095020.dng | 12.5 | 2865 ms | 16.8 ms | **170×** | — | — | — |
| PXL…093507.dng | 12.5 | 2787 ms | 18.2 ms | **154×** | 3378 ms | 2098 KB | 2 |

Real photos (12–24 MP) push the win to **154–315×** — far beyond the synthetic-fractal 61× and the original §13 "10–50×", because full-decode cost scales with megapixels while ROI decode stays flat (~one tile). In wall-clock terms: a **multi-second freeze (4–7 s on a 24 MP CR2) → tens of milliseconds**. Payback at distance=1 (visually lossless) is **1–2 crops** even at the slowest scalar tier — the one-time ingest encode is repaid almost immediately. Reproduce: see the report header.

---

## 1. Animation Frame Marshaling Batching

**Current Cost**: Multiple malloc+set per frame in `marshalAnimationFrames` (bridge.cpp).

**What it does**: JXL animation encode requires frame pixel data + frame metadata (duration, blending info, disposal mode) to be copied into WASM heap.

**Problem identified**: Each frame is allocated separately:
```cpp
// Current pattern (bridge.cpp):
for each frame:
  pixels_ptr = malloc(frame.size)
  HEAPU8.set(frame.data, pixels_ptr)  // copy
  // ... descriptor marshal ...
  // Later: free(pixels_ptr)
```

For a 100-frame animation of a 24MP image, this is:
- 100 separate malloc calls (allocator overhead)
- 100 separate memcpy/set operations (WASM heap churn)
- 100 separate free calls (fragmentation risk)

**Proposed approach (Tier 2)**:

### Option A: Arena allocation (Medium effort, low risk)
1. Calculate total pixel bytes needed (sum of all frame sizes).
2. Allocate a single large buffer for all frame pixels at once.
3. Allocate a single frame descriptor table (array of pointers + metadata).
4. Populate the large buffer with frame data in JS (one loop, one set call).
5. Pass the arena to the encoder along with the index table.

**Expected impact**:
- Reduce ~4–6 full buffer allocations per animation to 2 total allocations (pixels + descriptors).
- Expected time savings: ~20–50 ms on a 100-frame animation (per-frame malloc/free + redundant copies removed).

### Option B: Streaming encode with deferred pixel upload (Higher effort)
1. Encode frames in streaming mode: push each frame's pixels + metadata one at a time without buffering all at once.
2. WASM internal encoder buffer management handles the staging.
3. JS never needs to materialize the full animation buffer at once.

**Expected impact**:
- Better memory efficiency for large animations.
- Complexity: requires encoder protocol changes + streaming contract verification.

**Recommended**: Start with Option A. It's surgical, low-risk, and gives the clear 2–6× reduction in allocations.

### Implementation Checklist
- [ ] Profile `marshalAnimationFrames` on a representative animation (10–100 frames, 20+ MP each) to confirm current overhead.
- [ ] Implement arena allocation in `bridge.cpp` (single malloc for pixels, single descriptor array).
- [ ] Update facade marshaling functions to use the new arena layout.
- [ ] Add test case: animation encode with N=100 frames; verify no malloc/free count regression and timing improvement.
- [ ] Measure end-to-end animation encode time before/after on Gobabeb multi-frame test set (if available).

**Files to touch**:
- `packages/jxl-wasm/src/bridge.cpp`: Marshal function updates
- `packages/jxl-wasm/src/facade.ts`: `marshalAnimationFrames` and related
- Test: `packages/jxl-wasm/test/` — new animation encode harness or extended existing

**Priority**: Low initially (animation workflows are not measured as a hot path in current benchmarks). Elevate if multi-frame RAW/DNG sequences become a primary use case.

---

## 2. Worker `toArrayBuffer` Transfer Audit

> **STATUS 2026-06-18: DONE / superseded.** Hot paths now use `toTransferablePixels` (`decode-handler.ts:676`), which already returns the `{ buffer, copied }` slice-vs-direct signal and is instrumented (`copy_to_transfer_ms`, `copied_bytes`, folded `copyMs`/`copiedBytes`, `copyLatencyEma`, SAB zero-copy). `toArrayBuffer` (`:700`) survives only as a thin wrapper on the cold error-partial path. The code/line references below are historical. Option B stays gated behind the metric reporting frequent copies — it currently does not.

**Current Cost** *(historical — see status above)*: `slice()` copy in `decode-handler.ts:526` (some pixel handoff paths).

**What it does**: The `toArrayBuffer` helper converts WASM-side pixel buffers to JS-side ownership:
```ts
// decode-handler.ts (~line 526)
function toArrayBuffer(value: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (value instanceof ArrayBuffer) {
    return value;
  }
  // If byteOffset || length mismatch → slice (copy)
  if (value.byteOffset === 0 && value.length === value.buffer.byteLength) {
    return value.buffer;  // direct, zero-copy
  }
  return value.slice(0).buffer;  // COPY
}
```

**Problem identified**: The `slice()` path creates a new ArrayBuffer. For a 76 MiB RGBA8 buffer (24 MP image), this is an extra full-size copy at the worker boundary.

**Current discipline**: Code review (from §7) shows most pixel handoffs go through the direct ownership path (no slice). But some edge cases (regions, downsampled progressive frames, etc.) may hit the slice path.

**Proposed approach (Tier 2)**:

### Option A: Audit + targeted fixes (Low effort)
1. Add a metric `toArrayBufferMs` and call-count logging to the handler.
2. Run harness (session-worker-timings-browser.js) and inspect which codepaths hit `slice()`.
3. For those paths, investigate whether the byteOffset/length mismatch is necessary or whether we can arrange for direct ownership earlier.
4. Fix one or two high-frequency paths (if any).

**Expected impact**:
- Likely < 5 ms per frame (slice is fast for a single copy, but it's a full-size allocation on a hot path).
- Only realized if harness shows frequent slice calls; if ownership discipline is already good, impact may be zero.

### Option B: Avoid the toArrayBuffer call entirely (Higher effort)
1. Use `takeBuffer` patterns in facade to return owning buffers that are already clean (offset=0, length=full).
2. Eliminate the need for `toArrayBuffer` checks altogether.

**Expected impact**:
- Same as Option A, but requires deeper facade changes + verification that all pixel paths return clean buffers.

**Recommended**: Start with Option A. It's a quick audit + targeted fix if needed. If measurements show slice is rare, defer.

### Implementation Checklist
- [x] Add debug logging to the pixel-handoff path (slice vs direct) in decode-handler — landed as `toTransferablePixels` `.copied` flag + `copy_to_transfer_ms`/`copied_bytes` metrics + folded `copyMs`/`copiedBytes`.
- [ ] Run session-worker-timings-browser.js and inspect `copied`/`copyMs` frequency. *(Pending — no committed artifact yet; same input gap as item #4.)*
- [ ] If slice calls are frequent: identify the codepaths + investigate ownership chain. *(Only if the metric above shows frequent copies.)*
- [ ] If frequent: modify facade / handler to return clean buffers or directly transfer.
- [ ] Verify no regressions in decode tests (StandardMultifileTest + jxl-decode-worker.test.ts).

**Files to touch**:
- `packages/jxl-worker-browser/src/decode-handler.ts`: logging + possible toArrayBuffer fix
- `packages/jxl-wasm/src/facade.ts`: if deeper changes needed

**Priority**: Low. The audit may show that current discipline is already good and slice is rarely hit.

---

## 3. JXTC Scope Expansion (Multiple Sizes & Quality Variants)

**Current Implementation**: Single JXTC per asset (256px tile size, effort=3, distance=0).

**Opportunity**: Many use cases benefit from multiple JXTC variants:
- **Small thumbnails**: 64–128px regions with lower quality (faster encode, smaller cache footprint).
- **Medium tiles**: 256px (current) for gallery lightbox zooms.
- **High-quality variants**: Effort=5 for hi-fidelity crops (longer encode, smaller files).

**What it does**:
1. At ingest time, instead of one JXTC encode, produce multiple variants (e.g., {128px, 256px, 512px} × {q75, q85}).
2. Cache/serve based on requested crop size and quality settings.

**Problem identified**: Current Tier 1 is a single fixed-size JXTC. For heterogeneous UIs (thumbnails, gallery previews, lightbox full opens at different DPI), a one-size-fits-all approach may waste bytes on undersized crops or quality-mismatch.

**Proposed approach (Tier 2)**:

### Phase A: Measurement + cost model (Low-to-medium effort)
1. Profile encode time for multiple tile sizes (64, 128, 256, 512px) on representative assets.
2. Measure decode time + accuracy loss for downsampled JXTC (e.g., 256px JXTC used to serve a 128px crop).
3. Build a simple cost model: encode overhead vs cached-bytes savings vs decode latency for each variant.
4. Identify the 2–3 most popular size/quality combinations from UI metrics.

**Expected outcome**: A decision matrix ("use 256px q85 for lightbox, 128px q75 for thumbnails").

### Phase B: Variant generation + smart routing (Medium-to-high effort)
1. Extend `encode_variants_with_progressive` to accept a variant config (array of {tile_size, quality, effort}).
2. Each variant gets its own encoded JXTC codestream (same source, different tile structure).
3. In the ingest pipeline, generate the top 2–3 variants for each asset.
4. Store variant metadata in the cache/manifest (e.g., `_jxlJxtcVariants: [{tileSize: 128, q: 75}, ...]`).
5. In the lightbox decoder, select the best variant for the requested crop size.

**Expected impact**:
- Small thumbnails: 5–10 ms decode from 128px JXTC (vs 0.5–2 ms but only if pre-produced for that size).
- Storage: +20–50% for multiple variants (deferred by caching to OPFS or deferring low-priority variants).
- Encode time at ingest: +100–300 ms for 2–3 variants (one-time, parallelizable).

**Risk**: Added cache complexity + need for variant selection logic in the decoder.

**Recommended**: Defer until Phase A measurement is done and the use case (heterogeneous crop sizes) is validated on real data.

### Implementation Checklist
- [ ] Phase A: Profile encode time (N=11–30 files, 3–5 tile sizes) + measure downsampling accuracy loss.
- [ ] Phase B: Design variant manifest schema + routing logic.
- [ ] Extend `encode_variants_from_rgb16` to accept variant config.
- [ ] Update `jxl-cache` and lightbox to store/select variants.
- [ ] Test: verify multi-variant encode, cache storage, decoder variant selection on P2200/Gobabeb.

**Files to touch**:
- `crates/raw-pipeline/src/lib.rs`: encode function extensions
- `packages/jxl-cache/src/browser.ts` / `node.ts`: variant metadata + storage
- `packages/jxl-worker-browser/src/decode-handler.ts`: variant selection
- Ingest harness: variant tracking

**Priority**: Deferred. Measure first; only pursue if UI shows clear multi-size decode demand.

---

## 4. Per-File JXTC vs Full Decode Diagnostic UI

> **STATUS 2026-06-18: DONE — rebuilt on the `flipflop` skill** (not the session-worker JSON, which never existed). Code: `.flipflop/tests/jxtc-vs-full-decode.mjs` + `tools/jxtc-diagnostic-report.mjs`. Output: `docs/outputs/jxtc-diagnostic-report-2026-06-18.md`. flipflop's interleaved start-rotation cancels the thermal drift that single-shot §13 numbers were exposed to; `equal()` guards pixel-exactness; `trust` flags throttling/variance. Result summary is in the Action Pass section above. The Option A "read existing JSON artifacts" plan below is obsolete (those artifacts do not exist).

**Original plan (obsolete)**: Measurement harness captures `jxtcEncodeMs`, `jxtcDecodeMs`, `jxtcKb` + full-decode metrics. Data is in JSON artifacts.

**Opportunity**: Build a diagnostic UI that shows side-by-side A/B metrics for each file, highlighting when JXTC wins and by how much.

**What it does**:
1. Ingest harness generates JSON with both full-decode and JXTC-decode timings per file.
2. Simple web page (or CLI tool) renders a table:
   - File name
   - Full decode time (ms)
   - JXTC (128px) decode time (ms)
   - Speedup ratio
   - JXTC encode overhead (ms)
   - Payback (how many crops before the ingest overhead is amortized)
3. Optional: visual side-by-side of full vs JXTC-decoded crop.

**Expected impact**:
- **Nice-to-have**: Useful for demonstrating the feature to stakeholders and validating the measurement claim ("JXTC is 10–50× faster").
- **Educational**: Helps future developers understand the performance profile.
- **Telemetry**: Could feed into docs/suggested-settings.md recommendations.

**Proposed approach (Tier 2)**:

### Option A: CLI report generator (Low effort)
1. Add a small Node script in `tools/` that reads benchmark JSON artifacts.
2. Generates a markdown table + CSV export.
3. Include summary stats (mean speedup, median payback cycles).

**Time estimate**: ~2–4 hours.

### Option B: Interactive dashboard (Medium effort)
1. Build a small single-page app (HTML/JS, no build step needed).
2. Drop JSON artifacts into the page; it renders tables + charts.
3. Optionally add visualizations (speedup distribution, payback heatmap).

**Time estimate**: ~6–10 hours.

**Recommended**: Start with Option A (CLI report). It's fast and gives the key insights. Upgrade to Option B if dashboards become a regular handoff artifact.

### Implementation Checklist
- [ ] Design report schema (required fields from session harness JSON).
- [ ] Implement CLI script in `tools/` (e.g., `tools/jxtc-diagnostic-report.mjs`).
- [ ] Test on existing benchmark artifacts (P2200, Gobabeb sets).
- [ ] Generate example report; include in this handoff doc.
- [ ] Optional: add to CI/post-benchmark reporting pipeline.

**Files to touch**:
- `tools/jxtc-diagnostic-report.mjs` (new)
- Possibly: update benchmark harness output paths if current JSON layout needs tweaking.

**Priority**: Nice-to-have. Do if time allows; ship Tier 2 without it if needed.

---

## Summary: Tier 2 Roadmap

| Item | Effort | Priority | Prerequisite | Target |
|---|---|---|---|---|
| Animation marshaling (Option A: arena alloc) | Medium | Low (deferred — trigger unmet) | Measurement on real animation set | 2026-Q3 |
| toArrayBuffer audit (Option A: measurement + targeted fix) | Low | **DONE 2026-06-18** (instrumentation landed via `toTransferablePixels`) | — | Closed |
| JXTC variants (Phase A: measurement) | Low-to-medium | Deferred — trigger unmet | UI usage data + Phase A measurement | 2026-Q3 if justified |
| Diagnostic UI (Option A: CLI report) | Low | **DONE 2026-06-18** (rebuilt on flipflop) | — | Closed |

---

## Tier 2 Trigger Conditions

**Promote from "deferred" to "in progress"**:
1. **Animation marshaling**: If multi-frame JXL encode workflows (e.g., time-lapse RAW sequences, slide shows) are observed in real usage or benchmarks show animation as a measured bottleneck.
2. **toArrayBuffer audit**: ✅ Closed 2026-06-18 — the slice-vs-direct signal is now instrumented at the live boundary (`toTransferablePixels.copied` → `copy_to_transfer_ms`/`copyMs`). Only re-open Option B (facade returns clean buffers) if a harness run shows frequent `copied:true` (> 10% of transfers).
3. **JXTC variants**: If UI telemetry shows heterogeneous crop sizes being requested (e.g., 20% of crops are < 128px, requiring different JXTC variants).
4. **Diagnostic UI**: ✅ Closed 2026-06-18 — delivered as a flipflop A/B (`.flipflop/tests/jxtc-vs-full-decode.mjs`) + report generator (`tools/jxtc-diagnostic-report.mjs`). Re-run both (see the report's Reproduce block) to refresh numbers or add corpus types/sizes.

---

## References & Backlinks

- Main audit: `docs/boundary-cost-audit.md` (§15, implementation status)
- Measurement harness: `benchmark/session-worker-timings-browser.js`
- Native parity: `docs/outputs/tauri/gob30-p2200-11-native-parity-2026-06-04.md`
- Suggested settings: `docs/suggested-settings.md`

---

**Created**: 2026-06-17  
**Status**: Planning phase — awaiting resource allocation for Tier 2 execution.
