# QUESTIONS — Deferred

**From:** QUESTIONS.md breakdown + Mr. Smith comptroller (2026-06-19)

---

## Organization: By Workstream & Effort

Deferred items grouped by file/package scope + dependency + effort.

---

## WORKSTREAM 1: Raw-Pipeline Colour & Output Validation

**Priority:** HIGH (user-visible colour/geometry changes)  
**Gate:** Real camera files + user colour parity validation  
**Effort:** 20–30h (highly variable based on measurement results)

### User Decisions Required

| Issue | Item | Status | Gate |
|-------|------|--------|------|
| A2 | Exposure-time sentinel (DNG `den=1` vs ORF `den=0`) | Unimplemented | User decision: harmonize to `den==0`? |
| A3 | `color_matrix_from_mn` rename + docs | Unimplemented | Rename signal (DNG default vs user-supplied intent) |
| A4 | Colour matrix fallback semantics (None → CAM_TO_SRGB) | Unimplemented | Type-level enum or require explicit fallback per format |
| A5 | CR2 per-model colour matrix extraction | Stashed (project-cr2-colordata-matrix-todo.md) | Canon ColorData v>=6 wire-up; depends on A4 decision |
| A6 | Black/white level inference + per-channel extraction | Unimplemented | DNG per-CFA-channel read; CR2 WhiteLevel tag override |

### Colour Output Changes (Need Real File Validation)

| Issue | Item | Severity | Gate |
|-------|------|----------|------|
| B1 | Grbg/Bggr CFA alignment (align_to_rggb dead code) | Med | Real Grbg/Bggr DNG files + parity test |
| B2 | AsShotNeutral validation (zero/NaN handling) | Med | Audit callers; confirm no DNG relies on 0.0 clamp |
| B3 | DNG per-channel black levels | Med | Real DNG w/ per-channel black + colour validation |
| B4 | ORF color_matrix 0x1011 dtype gate | Med | Real Olympus body storing 0x1011 + colour parity |
| B5 | Demosaic degenerate 1×N handling | Low | Ensure m10c test still passes |

### Performance Opportunities (≥5% gate)

| Issue | Item | Expected | Effort | Status |
|-------|------|----------|--------|--------|
| C1 | Demosaic MHC +22% | +22% (synthetics) | 4h | Measure on real CR2/ORF; colour validation required |
| C3 | DNG tile endian branch | −3.8% | Low | REJECTED (below 5% gate) |
| C4–C10 | Downscale, pack_rgb16, rgb_to_rgba, LookRenderer | ? | 1–3h each | Flipflop measurement required |

### Structural Refactors (ADR-level)

| Issue | Item | Scope | Effort |
|-------|------|-------|--------|
| D1 | Unified TIFF/IFD reader | tiff/cr2/dng consolidation | 4h (cross-file) |
| D2 | Unified RawError enum | anyhow/String/bail → typed | 2h (cross-file) |
| D3 | Scene-referred RawImageMeta | Linear mode; CR2 colour matrix | 3h + user decision |
| D4 | Fast embedded-preview LOD tier | CR2/DNG half-res decode | 2h |
| D6 | EXIF orientation 2/4/5/7 | Mirror/transpose implementation | 2h + real test corpus |

### Perceptual Module (f32 vs f64 accumulator, sentinels, fused kernel)

| Issue | Item | Impact | Effort | Gate |
|-------|------|--------|--------|------|
| E1 | scale_err accumulator precision | <1e-4 rel drift @ full res | 3h | Parity test + benchmark |
| E2–E7 | Empty-buffer sentinels, PSNR alpha, fused kernel | Cross-metric | 5h | ADR + cross-backend coordination |

**Next:** Prioritize A2–A6 user decisions. Then measure C1, C4–C10 on real files.

---

## WORKSTREAM 2: Cross-Package Protocol & Contract Wiring

**Priority:** MEDIUM (enables worker communication)  
**Gate:** Cross-file coordination + unit tests  
**Effort:** 8–12h

### jxl-core Issues (span 3+ packages)

| Issue | Item | Files | Effort | Status |
|-------|------|-------|--------|--------|
| A1 | ~15 EncodeOptions fields missing wire | jxl-core + encode-session + worker | 3h | Unimplemented; extract mapper |
| A2 | Worker error codes outside JxlErrorCode | jxl-core + handlers + session | 2h | Unimplemented; merge unions |
| A3 | MsgWorkerError missing sessionId | worker + scheduler + session | 2h | Unimplemented; route to session |
| A4 | DecodeFrameMeta dropped by session.makeFrame | jxl-core + decode-handler + session | 1h | PARTIALLY FIXED (verify assignFrameMeta called) |
| A5 | decode_budget_exceeded metadata gaps | protocol + handler | 1h | PARTIALLY FIXED (verify metrics folded) |

### Stream Abort Contract (parity testing)

| Issue | Item | Files | Effort | Status |
|-------|------|-------|--------|--------|
| D1 | Abort contract resolve vs reject | browser + node + session | 2h user decision + 3h impl | Decided: RESOLVE ✅ (implemented browser.ts) |
| D2–D6 | Regression tests (parity, prefetch, 200-fallback, resume) | test/*.test.ts | 6h total | Unimplemented; depends on D1 decision |
| E1 | Node.js abort parity (node.ts) | node.ts (out-of-scope this review) | 3h | Unimplemented; coordinate with browser fix |

**Next:** Verify A4/A5 status (MEMORY.md says partly done). Then wire A1–A3. Then test D2–D6.

---

## WORKSTREAM 3: Scheduler & Worker Lifecycle

**Priority:** MEDIUM (backpressure + decode state machine)  
**Gate:** Verifier arbitration or trace evidence  
**Effort:** 8–12h

### Scheduler Invariants & Decisions

| Issue | Item | Status | Gate |
|-------|------|--------|------|
| A1 | One-primary-per-sourceKey assertion | Unimplemented | Add DEBUG flag guard; audit callers |
| A2 | CoreBudget unbounded waiter queue | Unimplemented | User decision: bounded or status quo |
| A3 | signalDrain double-decrement | ✅ FALSIFIED (not a bug; see Questions_implemented.md) | — |
| A4 | Promotion counter fragility | Unimplemented | Hardening (doc + invariant assert) |
| A5 | Buffered chunks unbounded overflow | Unimplemented | User decision: drop, error, or backpressure |

**Completed:** A3 (gauge invariant documented, b5249622).

### Decode-Handler Metrics & Test Gaps

| Issue | Item | Effort | Severity |
|-------|------|--------|----------|
| B1 | MAX_OUTPUT_BYTES_GUARD conservative | 1h | Info (policy doc) |
| B2 | output_bytes vs copied_bytes unification | 1h | Clarity |
| B4 | Missing unit tests (cancel/budget/drain) | 3h | Medium (coverage) |

**Next:** Decide A2 (waiter cap policy) and A5 (overflow semantics). Then implement B1–B4.

---

## WORKSTREAM 4: WASM FFI/ABI Layer

**Priority:** MEDIUM–HIGH (security + ABI correctness)  
**Gate:** WASM rebuild cycle (Docker/Emscripten, not available locally)  
**Effort:** 8–15h + rebuild time

### Facade.ts ABI Bugs (Deferred — requires rebuild + test)

| Issue | File | Severity | Lines | Status |
|-------|------|----------|-------|--------|
| B1 | encode_rgba8_with_metadata arg-shift | HIGH | +2 args | Unimplemented; rebuild + round-trip ICC/EXIF |
| B2 | 6 encoder options not forwarded | HIGH | +6 fields | Unimplemented; rebuild + test |
| B3 | ExtraChannel stride mismatch | MED | struct | Latent (no caller yet) |
| B4 | perceptualConstancyApplyBulk scalar fallback | MED | Impl | Fix link first (c-perceptual) |
| B5 | Leaks on throw (decoder, wasmEncState) | MED | Hoist | Unimplemented |
| B6 | rgb8 progressive pixelStride | MED | Stride | ADR: shared channel-stride helper |

### bridge.cpp (C++, cannot build here)

| Issue | Severity | Status | Rebuild |
|-------|----------|--------|---------|
| C1 | JXTC encode integer overflow | HIGH/security | PARTIALLY PATCHED (verify in build) | ✅ Build+test |
| C2 | Unvalidated FFI lengths | MED/security | Unimplemented | ✅ Build+fuzzing |
| C7 | Butteraugli ref deep-copy | HIGH/perf | Unimplemented | ✅ Build+flipflop (5–10% win) |
| C8 | SSIM two-pass fusion | MED/perf | Unimplemented | ✅ Build+test |

### Correctness (TS-only, no rebuild)

| Issue | File | Status |
|-------|------|--------|
| F1 | JPEG marker walk | ✅ IMPLEMENTED (b5249622) |

**Next:** Schedule WASM rebuild cycle. Coordinate B1–B6 (facade) + C1–C8 (bridge) + security audit.

---

## WORKSTREAM 5: Progressive Encode Architecture

**Priority:** LOW (Flagship ADR rejected; stay 3-pass or incremental)  
**Gate:** User pivot decision  
**Effort:** 5–15h (depends on path chosen)

### Flagship ADR Path (REJECTED)

**Status:** ❌ One-pass progressive encode quality gate FAILED (DC/AC tiers undecodable).

**Alternative paths:**
1. **Incremental** (Option 1): Keep thumb+preview tiers; add progressive_dc+group_order to full tier only (CPU-neutral, graceful big-image).
2. **Status quo** (Option 2): Stay 3-pass; close ADR as not-viable.
3. **Investigate** (Option 3): Why does prefix-decode fail? May be libjxl limitation.

**Recommendation:** Choose Option 1 or 2. Do not pursue one-pass-for-all-tiers.

### Cross-File Issues (if Option 1 chosen)

| Issue | Item | Effort |
|-------|------|--------|
| B1 | byteStart dead field | 0 (wait for format revision) |
| B2 | Manifest double-fetch race | 1h (share in-flight promise) |
| B3 | DC byteEnd exceeds file size | 0.5h (cap to fullFileSize - 1) |

### Performance (optional, low priority)

| Issue | Item | Expected | Gate |
|-------|------|----------|------|
| C1 | tick() dirty-flag (scheduler re-sort) | 73% sort, ~5–10% overall | Measure @ 200+ jobs |
| C3 | tee() buffering | Tier-size dependent | Measure P95 tier size |

**Next:** User decides Option 1/2/3. If Option 1, coordinate with encode-handler + manifest changes.

---

## WORKSTREAM 6: Additional Deferrals (Low Priority, Vision)

### Vision ADRs (Aspirational, backlog)

| Issue | Item | Files | Effort |
|-------|------|-------|--------|
| E1 | ManifestTier LOD metadata | manifest.ts | 2h |
| E2 | TierFetchOptions timeoutMs | scheduler | 1h |
| E3 | Typed perceptual passthrough | manifest schema | 2h (pending Perceptual Constancy) |
| E4 | onManifest ML-dispatch + render-budget | scheduler + types | 3h |
| E5 | Per-frame byte offsets | progressive-manifest | 2h |

### Verifier-Uncertain (Low severity)

| Issue | Item | Impact | Status |
|-------|------|--------|--------|
| H1 | take_flushed lifetime (bridge.cpp) | Low (decoder-side) | Comment-only; audit callers |
| H2 | Decoder cancel leak | Low (only if abandoned) | Code audit required |

---

## Effort Rollup (Deferred Only, Excluding Falsified)

| Workstream | Est. Effort | Gate |
|------------|-------------|------|
| 1: Raw-pipeline colour + perf | 20–30h | User validation + flipflop |
| 2: Cross-package protocol wiring | 8–12h | Cross-file coordination |
| 3: Scheduler lifecycle + tests | 8–12h | Verifier arbitration or trace |
| 4: WASM rebuild cycle | 8–15h | Docker/Emscripten build |
| 5: Progressive encode (if Option 1) | 5–10h | User decision |
| 6: Vision ADRs (backlog) | 10h | Aspirational, low priority |
| **TOTAL** | **60–90h** | **User + measurement gates** |

---

## Critical Path (Next 7–14 Days)

**Phase 1 (Today):** Consolidate output files (✅ done). User pivot decision on Flagship ADR → Option 1/2/3.

**Phase 2 (1–2 days):** Verify A4/A5 status (MEMORY.md). Decide A2 (waiter cap), A5 (overflow), B1 (MAX_OUTPUT_BYTES).

**Phase 3 (3–5 days):** Measurement + real-file validation (raw-pipeline colour C1, downscale C4–C10, scheduler C1).

**Phase 4 (5–10 days):** WASM rebuild + bridge.cpp security audit + B1–B6 facade fixes.

**Phase 5 (10–14 days):** Cross-package wiring (A1–A3, D2–D6 tests).

---

## References

- **QUESTIONS_BREAKDOWN.md** — Handoff structure + agent roles
- **Questions_raw-pipeline.md** — Raw decode scope
- **Questions_jxl-core-protocol.md** — Contract layer scope
- **Questions_jxl-worker.md** — Scheduler + handler scope
- **Questions_jxl-session-stream.md** — Session + stream scope
- **Questions_jxl-wasm.md** — FFI/ABI scope
- **Questions_progressive-encode.md** — Encode architecture scope
- **Questions_implemented.md** — 3 deployed quick wins (b5249622)
- **Questions_falsified.md** — 3 rejected items

---

## ac_strategy / ac_context deferred items (2026-06-29)

From the ChatGPT "holographic" pass on the 3rd-hottest file. Landed wins are on branch `capebio/perf/ac-strategy-coefforder-zdc1-jun29-x7q2` (C1 order-traversal + Set split; C2 ZeroDensityContext1). Items below are deferred — each is either a broad cross-file refactor, profile-led, or needs a measured WASM A/B before it can be judged. None are byte-exact-trivial.

1. **Unified `StrategyGeometry` descriptor** (replace the 3 per-strategy LUTs `covered_blocks_x/y` + `log2_covered_blocks` in ac_strategy.h with one struct, + raw-byte `AcStrategyRow` accessors). Marginal (the 3 LUTs are tiny constexpr, likely register-resident when inlined); wide blast radius (enc_group/dec_group/enc_ac_strategy/etc. all derive geometry). CLAUDE.md "no opportunistic refactors". Needs an end-to-end measurement showing the repeated derivation is actually visible before touching every caller.

2. **Paired order+LUT generation + canonical (cx,cy) order cache.** The 27 raw strategies collapse to 12 canonical coeff geometries; where both forward order AND inverse LUT are needed (enc_coeff_order.cc), one traversal could emit both, and orders could be cached by normalized geometry rather than raw strategy. Setup-cost only; only a win where both are consumed together (doubles write bandwidth otherwise). Measure before landing.

3. **QF-bucket precompute** for threshold-rich frames (split `BlockCtxMap::Context` qf-threshold scan into a precomputed per-block bucket plane). Keep the direct scan when `qf_thresholds.size() <= 1` (the common case). Profile-led — only helps multi-threshold frames; the default ctx map has 0 thresholds.

4. **Default `BlockCtxMap` alloc avoidance** (use `kDefaultCtxMap` static directly until a custom map is parsed; num_ctxs=15/num_dc_ctxs=1 are invariant). Cold-start latency only, not hot-loop. Needs move-ctor rebind of the data pointer. Marginal.

5. **Header zero-density table dedup** (`extern` decl + single .cc definition for `kCoeffFreqContext`/`kCoeffNumNonzeroContext`). WASM .data size only; measure object/.wasm sections for actual duplication first. Do NOT convert to arithmetic.

6. **`CountBlocksByType` bulk single-pass count.** Only worth it if a call-site audit finds repeated `CountBlocks` scans over the same image; otherwise sequential scan is fine.

7. **Packed 1-byte `AcStrategy`** (store raw byte, derive type/is_first). Profile-led; inlined call sites likely scalar-replace the current object already, so probably no gain and adds mask/extend ops.

8. **Forensic audit: `kZeroDensityContextCount` (458) vs `kZeroDensityContextLimit` (474).** Not an optimization — verify entropy-context allocation reserves the right bound and no malformed-stream path can index 458..473. Belongs once-per-block / in allocation policy, never as a per-coefficient clamp.

9. **nzero rect-fill / strategy-map rect-fill via std::fill_n/memset with a size threshold** (dec_group nzero propagation + the new SetUnchecked). Minor; bulk fill helps only large footprints, scalar stores win for 1x1/2x2. Optional micro-tune.

---

## 2026-06-29 — enc_entropy_coder.cc: deferred cross-file / architectural levers (ChatGPT pass)

Context: round-2 micro-opt pass on `lib/jxl/enc_entropy_coder.cc` (5th-hottest file).
Implemented byte-exact in-file (branch `perf/enc-entropy-count-decomp-jun29-z4x`,
submodule capebio): count-decomposition for both nzero counters. The following
larger ideas were surfaced but DEFERRED — each crosses file boundaries and/or
needs ratio/timing evidence before landing:

- **D1 — quantizer-produced exact nonzero counts.** Have the final quantization
  stage emit one exact AC-nonzero count per (channel, transform) into a compact
  side stream; tokenization then skips its leading SIMD count pass entirely.
  Biggest potential win (deletes a whole coefficient read for large transforms)
  but cross-file (enc_quant / enc_group plumbing) and must count only *after*
  the last stage that can alter coefficients. Needs an A/B build to size it.
- **D2 — entropy-scan-order coefficient staging.** Producer writes coefficients
  already in scan order so the token loop reads `block[k]` contiguously instead
  of `block[order[k]]` (permutation gather). Removes the order-table load and
  scattered loads, best for large transforms / WASM. Large upstream disturbance
  (may regress the quantizer's contiguous writes) — measure before committing.
- **D3 — persistent token-buffer high-water reserve.** Current per-group
  `output->reserve(worst_case)` over-commits for sparse groups and pins a large
  per-worker capacity. Replace with a `TokenizeScratch` carrying a rolling
  high-water hint (EncCache-level, cross-file). NOT byte-exact-affecting; needs
  telemetry (requested vs final size, realloc count, peak RSS, first-group ms)
  before tuning. Do NOT swap to `resize()+data()` raw writes — that value-inits
  the whole pessimistic buffer (worse for sparse).

## enc_convolve_separable5.cc (2026-06-29, after border-dedup landed on perf/conv5-border-dedup-jun29-bd7)

The big win (vertical-band rolling ring, +31-49%) is already in trunk. Border-row
horizontal dedup is now done (byte-exact, helps small/short planes; neutral on
full frames). Remaining ideas, all DEFERRED with reasons:

- **N / N+1 SIMD-width cliff.** Widths exactly `Lanes` or `Lanes+1` fall to the
  scalar `SlowSeparable5` (the fast path needs `xsize >= Lanes + kRadius`). A
  dedicated one-vector kernel (load center, mirror both sides via Neighbors +
  MirrorLanes, scalar-finish the +1 column) would cover them on SIMD. DEFERRED:
  niche (only two exact widths per target); needs its own HWY_SCALAR guard and a
  correctness pass against SlowSeparable5. Real-benefit unknown without width
  telemetry from butteraugli/detect_dots.
- **x-tiling for short-wide geometry.** The pool splits work by y-band only; a
  few-rows-tall, very-wide plane yields too few band-tasks to fill cores. Add x
  tiles ONLY for short/wide (keep y-band default). Constraints: internal tile
  boundaries use ordinary HorzConvolve, only the global left/right edges mirror,
  never call Separable5 on sub-Rects (horizontal borders are rect-bound).
  DEFERRED: profiling-gated; needs evidence such planes dominate any caller.
- **Status propagation from RunInteriorRows.** `RunOnPool`'s Status is asserted
  in debug then discarded; `Run()` always returns true. Latent reliability gap
  (a runner failure reports success), not perf. DEFERRED: out of optimization
  scope; thread to Run() in a separate correctness change.
- **Weight-family dispatch (identity / 3-tap / horizontal-only / vertical-only).**
  Classify `WeightsSeparable5` once at construction and skip zero taps. DEFERRED:
  data-led only — needs coefficient telemetry that those families actually reach
  this function; also changes NaN/signed-zero propagation, so not byte-exact.
- **Scalar-tail abs/Mirror hygiene.** The remainder loop recomputes `std::abs(dy/dx)`
  weight indexing and calls `Mirror` for every column incl. interior ones. Could
  hoist weights and skip Mirror until the final two columns. DEFERRED: micro
  (< Lanes columns/row), and must preserve the exact 25-term accumulation order
  to stay byte-exact — low value, easy to get subtly wrong.

---

## enc_convolve_separable5 — ChatGPT 3-pass analysis leftovers (2026-06-29)

Context: y-reuse ring + remainder-collapse already landed on submodule main
@10783f7e; border-row dedup landed on `perf/enc-conv5-border-dedup-jun29-r3x`.
Remaining ChatGPT suggestions, deferred:

1. **SIMD width-cliff (xsize == N or N+1).** These widths fall to `SlowSeparable5`
   though one custom vector could cover them. NOT byte-exact vs the current slow
   path (different numerical reduction tree for those widths) → needs an explicit
   tolerance/identity decision before landing. Low value (narrow rects only).
2. **x-tiling for short/wide geometry.** When `num_bands` is tiny (few-row, very
   wide rect) the y-band scheduler under-fills cores. Add x-slicing (internal
   tiles only; global edges keep mirroring; never recurse `Separable5` on sub-
   rects — horizontal borders are rect-bound). Scheduler change; butteraugli's
   roughly-square pyramids rarely hit this. Needs its own benchmark.
3. **SIMD output-rect / in-place API.** Fast path requires `SameSize(rect,*out)`
   and origin-zero output; callers needing a sub-rect must materialize+copy. A
   `Separable5ToRect` (StoreU when unaligned) or delayed-write in-place variant
   could remove a full-plane round-trip. Audit `butteraugli.cc` Blur and
   `enc_detect_dots.cc` for such temporaries first — potentially bigger than any
   inner-loop change, but a caller-contract refactor.
4. **Weight-family classification** (identity / 3-tap / h-only / v-only). Classify
   once in `WeightsSeparable5` ctor, dispatch specialized kernels. Needs
   coefficient telemetry to justify; risks NaN/signed-zero policy changes and
   per-Highway-target code bloat. Data-led only.
5. **Status propagation.** `RunInteriorRows` does `JXL_DASSERT(status); (void)`
   — a pool failure is reported as success. Thread through `Run()`. Reliability,
   not perf; tiny.

---

## enc_adaptive_quantization — ChatGPT 4-pass analysis leftovers (2026-06-29)

Context: This is the hottest remaining enc file. Big batch already landed on
submodule main @10783f7e (6c8dd38a): TileDistMap margin==0 fast path, FuzzyErosion
2×2 fusion, MaskingSqrt kSqrtMul precompute, AdjustQuantField 1x1-skip + mean-only-
when-covered≥4, quantizer-const hoist, MaxError any_change exit + per-block clip,
terminal-iteration Butteraugli skip. THREE more byte-exact opts landed on branch
`perf/enc-aq-fixedpoint-hfblue-jun29-q8x` (capebio, off 10783f7e): cur_pow==0
fixed-point early-exit (+13% e9 on real RAW), HF-dominates-blue short-circuit,
HfModulation dy==7 vertical no-op. Remaining ChatGPT suggestions, deferred:

### Output-changing (need ratio + Butteraugli regression, NOT byte-exact)
1. **pow(x, 1/16) → 4× std::sqrt** in TileDistMap tile_dist. Mathematically equal,
   much cheaper (esp. WASM), but NOT bit-identical → changes AQ decisions → output
   bytes. Gate behind size/Butteraugli corpus regression.
2. **std::pow(diff, cur_pow) → FastPow2f(FastLog2f·k)** in the quant-update loop.
   cur_pow is only ever 0.2 (i<2) or 0 in practice. Fast path promising on WASM;
   crosses quant-bin boundaries → corpus-validate.
3. **SIMD fast-log for mask1x1** (replace scalar std::log1p per pixel with vector
   FastLog2f). Large scalar-libm cost on the full-res 1x1 Laplacian pass. Changes
   the masking heuristic → validate on HDR/low-light/edge-heavy images.
4. **Merge the two gamma-Laplacian walks** (scalar mask1x1 + SIMD 4×4 pre-erosion
   both compute gammac·(in−neighbour_avg)). One signed-Laplacian producer feeding
   both. Scalar-vs-SIMD association differs → not byte-exact; experiment only.

### Architectural (large surface / correctness risk)
5. **Persistent AQ round-trip context (E/F — ChatGPT's "most strategic").** Reuse
   PassesDecoderState / ModularFrameEncoder / render pipeline / GroupDecCache /
   decoded ImageBundle across the 2–5 FindBestQuantization iterations instead of
   rebuilding each round; plus an AQ-narrow InitializePassesEncoder that skips
   special-frame/entropy-token/bitstream-only work (note the existing
   `special_frames.resize(num_special_frames)` rollback — generic init does work
   AQ discards). Biggest potential multi-ms win but touches decoder reset
   contracts → must prove byte-exact across corpus (stale group caches are the
   hazard). Compounds with the landed render-pipeline descriptor reuse.
6. **Strategy-cell native representation.** After AdjustQuantField every member of
   a variable AC strategy is uniform and TileDistMap broadcasts one residual back
   over the same footprint; the iterative state is really one (q, residual,
   initial) per AC-strategy root. Represent it that way (no expand→update→collapse
   per block; direct strategy residual accumulation in the comparator). Removes
   duplicated div/pow/lround/clamp. Large refactor touching the Quantizer API
   (SetQuantFieldFromStrategyCells); byte-exactness needs care.
7. **Incremental sparse round-trips.** After the first refinement only some raw
   quant cells change; re-encode/re-render only affected groups + AC/EPF/render/
   Butteraugli halo. Very high complexity (invalidation-radius correctness);
   highest payoff at Tortoise. Research-grade.
8. **Staged Gamma+HF fusion** (G, conservative form). Combine the Gamma and HF
   per-block scans (both consume X/Y) — NOT the full 3-way fuse (register
   pressure / WASM regression risk per ChatGPT's own walk-back). Keep independent
   accumulators/order for byte-exactness; benchmark native + WASM separately.

### Minor byte-exact, deferred (low value or small risk)
9. **tile_distmap buffer reuse** across iterations (refactor TileDistMap to fill an
   existing ImageF). Saves a small blocks-sized alloc per iteration (only 2–5×);
   marginal now that #1 cuts iterations.
10. **score / ScaleImage(-1) debug-gating.** Release-dead: TileDistMap raises diff
    to the 16th (even) power so the sign flip can't matter; `score` only feeds a
    debug printf. Pass nullptr + #if-guard. Tiny.
11. **High butteraugli_target (≥14) modulation bypass.** dampen==0 → result is a
    constant base_level; skip Gamma/HF/Blue entirely. Rare target; low value.
12. **ComputeTile SIMD-tail off-by-one** (`x + 1 + Lanes < x_end` → `x + Lanes <
    x_end`). Recovers one vector/row but is a bounds-sensitive change near the
    right-neighbour load — needs careful padding audit; skipped as too risky for
    one vector.
13. **mask1x1 tile-local fused blur** (fuse raw mask1x1 production with Symmetric5
    over each tile's core + 2px halo, removing the full-res intermediate + barrier).
    Seam risk at internal tile boundaries (current halos only cover the outer rect
    edge); benchmark vs the optimized full-image Symmetric5 before adopting.
14. **Max-error: accumulate max during group decode** instead of writing then
    re-reading the full decoded image. Complication: strategy regions crossing
    group boundaries (need root-index map + reduction). Max-error mode only.

### enc_convolve_separable5 — secondary items (2026-06-29)

The register rolling ring is the shipped interior optimum (x-tile scratch ring
tested and rejected, see rejected-opts CONV5-2). Remaining ChatGPT secondaries,
deferred as low-EV for the WASM 4-lane butteraugli/dots callers:

15. **Equal-axis 3-weight load** (byte-exact). `butteraugli.cc` Blur calls
    Separable5 with `horz == vert`. Detect equality once and load 3 broadcast
    weight vectors instead of 6, passing each to both stages → frees 3 vector
    registers in the hot `RingColumn`. Same Add/MulAdd order → byte-exact.
    Uncertain micro-win; the ring is not spill-bound on AVX2/WASM today (it
    already hits the +39–49% ceiling), so register relief may not show. Measure
    before adopting.
16. **Narrow capped-SIMD fallback** — AVX-512-only concern (widths 6–17 fall to
    SlowSeparable5). Irrelevant to the WASM ship target (already 4-lane; only
    sub-6px images affected). Skip unless a native AVX-512 path matters.
17. **Direct 2-D / isotropic kernel** — saves a few arithmetic ops but keeps the
    25-source-load pattern and **reorders accumulation → NOT byte-exact**. Would
    change butteraugli scores → encode bitstream; needs decode-SHA + Butteraugli
    quality gating, not the encode-SHA gate. Out of scope as a default path.

---

## dec_ans.{h,cc} TTFP pass — deferred (2026-06-29)

Branch `perf/dec-ans-ttfp-inline-jun29-z4k1` (capebio submodule, off main
@10783f7e) landed 3 byte-exact wins (W1 hot-path no-LZ77 inline via
`ReadHybridUintClusteredMaybeInlined`; W2 `std::move(counts)` into by-value
`InitAliasTable`; W3 ReadHistogram heap vecs → 258-stack arrays). 14/14 testable
files decode byte-exact (native static djxl OLD@10783f7e vs NEW), native ST
+2.5% median on _cap (noisy, no regression). Deferred from the same analysis:

1. **Definitive WASM/browser TTFP bench of W1.** Native ST is +2.5% but noisy and
   a weak proxy — inlining wins are WASM-codegen-dependent (cf. the "SSSE3 proxy
   lied for transpose" lesson). Real gate before merge: rebuild the dec WASM tiers
   from this branch and A/B first-paint via the browser harness (flipflopdom) on
   real RAW→JXL O1 blobs. ~34min WASM build.
2. **Split LZ77 state out of `ANSSymbolReader` (or at least drop the
   `special_distances_[120]{}` zero-init).** No-LZ77 readers currently zero-init
   ~480B + carry LZ fields. Cold-start/first-group win, but needs a profile to
   confirm reader construction shows up, and MSan/fuzz after removing the init.
3. **Bounded LZ window.** 4 MiB (`kWindowSize`) allocated per LZ reader regardless
   of how many values it can emit. Pass a proven max-emit bound from the caller →
   allocate `min(kWindowSize, max_emit)`. Needs caller plumbing; LZ-streams/cold
   start only.
4. **Virtual zero-run instead of the initial `distance==0` memset.** Up to 4 MiB
   memset before useful decode. Model as a `zero_run_` flag (incl. Save/Restore).
   Needs real-corpus frequency of first-run zero copies to justify.
5. **`IsSingleValueAndAdvance` degenerate fast-path.** Use precomputed
   `degenerate_symbols[ctx]` (add a `const int*` reader member) to skip the alias
   lookup. Byte-exact-plausible but needs careful verification that value + state
   advancement match exactly; marginal (only when that optimization path is hit).
6. **`uint16_t alphabet_sizes` overflow hardening (dec_ans.cc:204-208).** Real
   latent bug: `DecodeVarLenUint16()+1` can be 65536 → wraps to 0 in uint16_t
   BEFORE the `> max_alphabet_size` check (valid streams never reach it, so
   byte-exact). Malformed-input robustness only; deserves its own fix + fuzz, not
   a perf-pass rider.
7. **Defensive `max_num_bits = 0` reset + `degenerate_symbols.assign(n,-1)`.**
   No-op in the current flow (ANSCode is freshly constructed per DecodeHistograms,
   not reused) — only matters if ANSCode reuse is ever introduced. Harmless; skip
   until reuse exists.
8. **Per-target A/B of (a) alias-table prefetch on/off and (b) ANS normalization
   branchful vs branchless.** Both are target-sensitive (the source comment only
   claims parity "on SKX"); choose at compile time per target, never a per-symbol
   runtime heuristic. Needs WASM + native A/B.
9. **Setup micro-ops:** single `Refill()` batching in DecodeVarLenUint8/16 +
   DecodeUintConfig; table-lookup (CTZ) for the unary shift prefix (the file's own
   `TODO(veluca)`); packed-RLE rewrite of the histogram scratch (W3 already moved
   it to the stack — the further RLE-into-logcounts packing is byte-exact-risky and
   low value).

---

## enc_modular R1–R4 + D2 pass (2026-06-29, branch capebio/perf/enc-modular-r1to4-d2-jun29-q4z)

Landed (byte-exact, see branch): R1 two-phase single-group prepare + pool for the
Global RCT/WP search; R2 AddACMetadata zero-channel construction; R3 reserves; R4
uint32 extra-channel guard + gi_channel_ reuse-clear; D2 EstimateCost workspace
reuse across the RCT search.

Deferred from THIS pass:
1. **Subsampled `AddVarDCTDC` exact allocation (4:2:0 / 4:2:2).** The shared
   `Image::Create(...,8,3)` makes three full-res planes; the subsampled branch then
   `shrink()`s the two chroma planes (full-res backing already allocated). Allocating
   each channel at final dims needs splitting the shared create across the four
   branches. Rare path — the RAW pipeline is 4:4:4, so never exercised here. Byte-exact
   memory-only win; do it if a subsampled-input workload appears.
2. **R1 pool speedup is multi-thread-only and single-group-only.** The two-phase split
   is byte-exact and removes a real data race, but its FwdRct/do_transform parallelism
   only helps when (a) encode uses a thread pool and (b) the frame is one group (small
   images / TTFP preview blobs). The 1-thread A/B harness cannot measure it; verified
   byte-exact instead. Multi-thread single-group bench is the open measurement.
3. **D1 palette `cost_before` carry-forward and D3 bounded EstimateCost scoring**
   remain deferred (see external/libjxl-012/HANDOFF_enc_modular.md). D1 changes the
   bitstream (needs a size bench); D3 is NOT byte-exact (fractional-entropy floor is
   nonlinear, so dropping the constant non-colour channels can flip a near-tie RCT
   choice) — confirmed this pass, do not land as "byte-exact".

## 2026-06-30 — quant_weights / quantizer deferred (3rd-hottest-file pass)

Landed byte-exact this pass on `perf/quant-weights-byteexact-jun30-q9z3k` (submodule,
capebio, off `00f4d7fc`): GetQuantWeights channel-fusion + num_bands==1 hoist,
ComputeQuantTable direct-write into inv_table, SetQuantField buffer reuse. Harness
`tools/quant_weights_equiv_ab.cc` (833 configs + recip, 0 fails). Deferred — all
need measured WASM A/B and/or are not byte-exact-trivial:

1. **Per-table, directional lazy materialization of DequantMatrices.** First
   `EnsureComputed` allocates the whole universe (~3.01 MiB: table+inv for all 2056
   blocks × 3) even for a DCT-only frame that needs ~1.5 KiB. Biggest first-paint/peak
   win, but the riskiest: `InvMatrix` has deliberately-zeroed low-frequency entries
   (`quant_weights.cc` low-freq zeroing) so it is NOT a pure reciprocal — cannot blindly
   split dequant/inverse storage without auditing every `InvMatrix` caller. Use a
   `computed_table_mask_` + dual mode (table-granular for sparse decoder requests,
   one contiguous slab for all-strategy encoder requests). Keep table construction
   single-threaded before workers read matrix pointers.
2. **`inv_quant_ac` 256-entry LUT.** `inv_quant_ac(q) = inv_global_scale_ / q` divides
   per call; valid `q` clamped to [1,256]. Fill `inv_quant_ac_[1..256]` once in
   `RecomputeFromGlobalScale` (bit-exact, q≤256 exact in float). Worth it only if the
   call is genuinely in the per-block hot path — profile call rate first; +1 KiB/quantizer.
3. **`InterpolateVec` `b/a` ratio precompute.** Removes a vector divide per interp, but
   NOT byte-exact (scalar precompute vs vector `Div` shifts float bits). Bench + matrix
   bit-hash across HWY targets before landing; only after the byte-exact set is stable.
4. **`AdjustQuantBias` all-small (0/±1) fast path.** Skip `ApproximateReciprocal` when
   `AllTrue(is_01)`. Output-exact but distribution-sensitive (the `AllTrue` reduction
   can lose on dense coefficient blocks). Needs sparse-vs-dense corpus bench.
5. **SIMD `SetQuantFieldRect`** (currently scalar `ClampVal(qf*scale+0.5)`). MulAdd →
   clamp-in-float → truncate. Win only for large adaptive-quant maps; setup/dispatch
   can lose on 8×8. Bench-gated.
6. **Native-wide `GetQuantWeights`** (it hard-caps `DF4 = HWY_CAPPED(float,4)`; leaves
   AVX2/512 throughput on the table for 16×16+). Low priority for the WASM target (no
   gain there); only if native desktop matters after the alloc/cache fixes.
7. **Trivial cleanliness.** LANDED in commit `9c848f62` (byte-exact by construction):
   RAW `new std::vector<int>(std::move(qtable))` (was default-construct + copy from named
   rvalue), and drop the constructor's redundant `inv_quant_dc_` assignment
   (RecomputeFromGlobalScale already sets it with the identical expression). STILL
   deferred: `predefined * kNumQuantTables + table` library indexing (dormant — 1
   predefined set today, pure future-proofing), and init DC padding lane
   `mul_dc_[3]/inv_mul_dc_[3] = 1.0f`. The DC-lane init is NOT shippable as "byte-exact"
   without auditing the 4 raw-pointer `MulDC()`/`InvMulDC()` consumers (dec_frame.cc:354,
   dec_modular.cc:477, enc_cache.cc:244, enc_modular.cc:1860) for a 4-wide load that uses
   lane 3 — if one exists it currently reads uninitialized memory and the init would
   change output (a latent-bug fix, not byte-exact); if none, it is harmless robustness.
8. **inv_quant_ac 256-LUT — re-evaluated, staying deferred (now with flipflop model
   data).** Single caller (`enc_group.cc:397`) calls it once per BLOCK and broadcasts the
   result with `Set`, so it removes one division per block, not per coefficient — and the
   div is already amortized over the block's ~kDCTBlockSize/lanes coefficient ops. The
   eager LUT refill is 256 divisions on every `RecomputeFromGlobalScale` (ctor + 2× in
   `ComputeGlobalScaleAndQuant` + `ScaleGlobalScale` + `Decode`), so it does pure-waste
   work on the DECODE path (only the encoder reads the table). Byte-exact + bounded
   ([1,256]).

   Three byte-identical strategies flipflopped (`.flipflop/tests/inv-quant-ac-lazyfill.mjs`,
   JS model of the encode access pattern — directional only, NOT real WASM): DIV (current)
   vs EAGER LUT (refill every recompute) vs LAZY LUT (fill once on first use, decode
   skips). `equal()` = bit-identical accumulator (byte-exact re-proof). Result (min_ms,
   clean mandel workload; all rows trust:low — V8 GC/JIT noise + desktop thermal-unknown):
   EAGER ~+13-15%, LAZY ~+5-12% vs DIV; EAGER ≳ LAZY on encode (lazy's `if(!ready)` branch
   + first-block fill). So LAZY's only real edge is removing the decode-path refill.

   Decision: do NOT land on trust:low JS evidence. Unlike the shipped byte-exact work
   (pure work-removal), a LUT ADDS mutable state + a branch to a hot inline; needs a real
   WASM enc A/B (where div is relatively costlier, so the LUT win is likely larger) before
   committing. If landed, prefer LAZY (no decode penalty) over EAGER.

Integrator gate for the landed branch: WASM enc A/B (fusion's real FastPowf/sqrt gain is
codegen-dependent; harness microbench is scalar/pow-dominated = 1.17x floor, not the
SIMD number) + full libjxl compile (third_party submodules were not init in the worktree,
so no real compile ran — scalar harness proves the loop-restructure byte-exact only).
