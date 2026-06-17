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

**Current Cost**: `slice()` copy in `decode-handler.ts:526` (some pixel handoff paths).

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
- [ ] Add debug logging to `toArrayBuffer` (call count, slice vs direct path) in decode-handler.
- [ ] Run session-worker-timings-browser.js with logging enabled; inspect results.
- [ ] If slice calls are frequent: identify the codepaths + investigate ownership chain.
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

**Current Implementation**: Measurement harness captures `jxtcEncodeMs`, `jxtcDecodeMs`, `jxtcKb` + full-decode metrics. Data is in JSON artifacts.

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
| Animation marshaling (Option A: arena alloc) | Medium | Low | Measurement on real animation set | 2026-Q3 |
| toArrayBuffer audit (Option A: measurement + targeted fix) | Low | Low | Current codebase | 2026-Q2 or as-needed |
| JXTC variants (Phase A: measurement) | Low-to-medium | Deferred | UI usage data + Phase A measurement | 2026-Q3 if justified |
| Diagnostic UI (Option A: CLI report) | Low | Nice-to-have | Current benchmark artifacts | 2026-Q2 (bonus) |

---

## Tier 2 Trigger Conditions

**Promote from "deferred" to "in progress"**:
1. **Animation marshaling**: If multi-frame JXL encode workflows (e.g., time-lapse RAW sequences, slide shows) are observed in real usage or benchmarks show animation as a measured bottleneck.
2. **toArrayBuffer audit**: If harness measurements show frequent `slice()` calls (> 10% of transfer calls), or if decode latency becomes a focus area.
3. **JXTC variants**: If UI telemetry shows heterogeneous crop sizes being requested (e.g., 20% of crops are < 128px, requiring different JXTC variants).
4. **Diagnostic UI**: If future optimization campaigns need a dashboard to compare approaches, or if stakeholder demos require visualization of the JXTC wins.

---

## References & Backlinks

- Main audit: `docs/boundary-cost-audit.md` (§15, implementation status)
- Measurement harness: `benchmark/session-worker-timings-browser.js`
- Native parity: `docs/outputs/tauri/gob30-p2200-11-native-parity-2026-06-04.md`
- Suggested settings: `docs/suggested-settings.md`

---

**Created**: 2026-06-17  
**Status**: Planning phase — awaiting resource allocation for Tier 2 execution.
