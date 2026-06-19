# QUESTIONS — raw-pipeline (cr2, dng, orf, demosaic, frame_stats, perceptual)

**Source:** EpicCodeReview 20260617T202430Z + 20260619T093126Z + 20260619T130214Z

## Scope
This file consolidates deferred findings for **crates/raw-pipeline/** decoders and utilities:
- `src/cr2.rs` — CR2 raw parsing, metadata extraction, colour matrix
- `src/dng.rs` — DNG parsing, black/white levels, demosaic
- `src/tiff.rs` — TIFF/IFD parser (shared by ORF, DNG, CR2 preview)
- `src/ljpeg.rs` `src/demosaic.rs` `src/decompress.rs` — pixel decode pipeline
- `src/frame_stats.rs` — histogram, luma variance, frame hash
- `src/perceptual/{mod,butteraugli,blur,ssim,psnr,simd/*}.rs` — Butteraugli/SSIM/PSNR metrics + SIMD backends
- `src/lib.rs` (2842 lines) — WASM exports, top-level ORF/DNG/CR2 decode, LookRenderer, downscale

## Handoff Strategy
**Subagent type:** Explore (for discovery/architecture questions) + general (for measurement/ADR reasoning)  
**Model:** Sonnet (balanced for correctness + design reasoning)  
**Effort:** Medium (policy/architecture decisions need human ratification; no code commits without sign-off)

**Timing gates:**
- Perf findings need flipflop measurement (5% threshold per CLAUDE.md)
- Output-contract changes need user verification on real camera files
- Cross-file refactors need ownership clarification

---

## CATEGORY A: Deferred — Public API / Output Contract Changes (NO AUTO-FIX)

### A1 — Flag collision `OUT_FULL_16 == OUT_NO_ORIENT == 8` (src/lib.rs:551,556)
**Status:** RESOLVED 2026-06-19 — was accidental collision (independent additions), moved OUT_NO_ORIENT → bit 16.  
**Resolution:** Already committed on epiccodereview/20260619T093126Z branch.  
**Action:** Verify JS-side flag updates match if this branch lands.

### A2 — Exposure-time sentinel divergence (DNG `den=1` vs ORF `den=0`)
**Finding:** DNG/CR2 use `den=1` as "absent"; ORF uses `den=0`. JS consumers check `den==0`.  
**Impact:** Silent incorrect exposure metadata for DNG/CR2 via WASM.  
**Decision needed:** Harmonize the sentinel (recommend all use `den==0` with a doc comment).  
**Effort:** 1h — one-line change in dng.rs/cr2.rs + JS-side audit.

### A3 — `color_matrix_from_mn` misleads about DNG intent (src/lib.rs)
**Finding:** DNG supplies a default ColorMatrix (so `color_matrix_from_mn` is always true for DNG); ORF often lacks one (flag is informative). JS cannot distinguish "user-supplied" from "defaulted".  
**Impact:** JS applies Olympus LUT semantics to DNG + CR2 defaults.  
**Suggested patch:** Rename to `color_matrix_is_embedded` + document that DNG defaults to CAM_TO_SRGB when absent.  
**Effort:** 2h — rename + audit callers.

### A4 — `color_matrix` semantics: None → CAM_TO_SRGB fallback collapses three intents
**File:** pipeline.rs:1033-1038 (fallback repeats at :1159/:1235/:1284/:1410)  
**Issue:** When `color_matrix` is None, code uses Olympus fallback for DNG/CR2/ORF equally. But:
- DNG should default to identity (scene-referred, per spec)
- CR2 should use per-model matrix (currently missing, see A5 below)
- ORF is genuinely Olympus
  
**Impact:** DNG/CR2 get wrong white balance / hue rendering.  
**Suggested patch:** Type-level enum (`enum ColorMatrix { Identity, Camera(...), GenericOlympus }`) or require explicit fallback per format. Needs user decision on per-format defaults + cross-format caller audit.

### A5 — CR2 ColorData matrix extraction unimplemented (cr2.rs:228-240)
**Status:** Stashed in `project-cr2-colordata-matrix-todo.md`  
**Issue:** Canon CR2 stores per-model colour matrix in ColorData v>=6; currently dropped → all CR2 uses generic Olympus fallback.  
**Measurement:** Unknown; likely 5-15% hue shift on Canon bodies.  
**Suggested patch:** Extract `colorMatrix` from ColorData tag when present; merge with A4 (unified colour-matrix intent enum).

### A6 — Black/white levels inference table vs per-file tags (cr2.rs:481-488, dng.rs:87-88,358-359)
**File:** cr2.rs, dng.rs  
**Issue:** Both infer black/white from precision magic table; CR2 never overrides from file; DNG reads first_f32(0) only (ignores per-CFA-channel arrays).  
**Impact:** Cameras with stored black/white levels render subtly darker/lighter + wrong colour if black is per-channel.  
**Suggested patch:**
- CR2: parse Canon WhiteLevel tag (if present) and prefer over table.
- DNG: read full `BlackLevelRepeatDim` + `BlackLevel` array (0xC619 + 0xC61A), apply per-CFA-position in `subtract_black_in_place`.
**Measurement:** Needs ground-truth per-camera validation (user confirms colour parity).

---

## CATEGORY B: Deferred — Colour/Demosaic Output Changes (NEED REAL FILE VALIDATION)

### B1 — align_to_rggb dead code for col_off==1 (dng.rs:297-313)
**Finding:** Grbg/Bggr CFA patterns (col_off==1) don't adjust column phase → misaligned demosaic.  
**Status:** Dead in production (no in-crate callers); latent only.  
**Suggested patch:** For col_off==1, crop one leading column and adjust width/height before demosaic.  
**Gate:** Real Grbg/Bggr DNG files + pixel-parity test.

### B2 — AsShotNeutral validation gap (dng.rs:80-85, 1052-1057)
**Issue:** Zero/NaN/invalid components → `0.0` clamp → WB multiplier ~1e6 → wild colour shift.  
**Suggested patch:** Return `None` on non-finite/<=0 components so decode falls back to neutral WB=1.0.  
**Gate:** Audit all `analyze_shot_neutral` callers; confirm no existing DNG deliberately relies on 0.0 clamping.

### B3 — DNG per-channel black levels (dng.rs:87-88)
**Issue:** Black/white are `Option<u16>` (single value); DNG spec allows per-CFA-channel arrays.  
**Suggested patch:** Widen to `[u16;4]`, apply per-CFA-position in `subtract_black_in_place`.  
**Gate:** Real DNG with per-channel black + colour validation.

### B4 — ORF color_matrix 0x1011 dtype gate (tiff.rs:597-606)
**Issue:** 0x1011 read without dtype check (missing `dtype==8` SSHORT gate that 0x0200 sibling has).  
**Suggested patch:** Gate on `dtype==3 || dtype==8` to match 0x0200; decide signed-vs-unsigned per dtype.  
**Gate:** Real Olympus body storing 0x1011; validate colour parity.

### B5 — demosaic single-row degenerate handling (demosaic.rs)
**Issue:** 1×N/N×1 inputs clamp edge neighbours → degenerate-but-valid output (not error).  
**Suggested patch:** Add optional `validate_min_dims(w,h,min)` so callers can opt-in to strict Err on sub-2.  
**Gate:** Ensure m10c 1×1/1×N/N×1 test still passes with fallback to clamping.

---

## CATEGORY C: Deferred — Performance Opportunities (MEASURE BEFORE APPLYING)

**Gate: ≥5% speedup + output parity (per CLAUDE.md).**

### C1 — ORF double demosaic (planar + MHC always; MHC dropped on preview)
**Findings:** hacker-001, architecture-004/006, structure-003/010  
**Suggested:** Profile whether MHC on full-res + fast bilinear on preview is faster than MHC on both.  
**Flipflop:** `examples/demosaic_variants.rs` or `.flipflop/tests/orFull-mhc-vs-bilinear.mjs`

### C2 — DNG tile-decode endianness-branch hoist (dng.rs tile loop)
**Measurement:** flipflop `dng-tile-decode` = 3.8% slower on geomean (−25%…+19%, trust:low).  
**Verdict:** Below 5% gate; path is cold (backup only). REJECTED.

### C3 — Demosaic phased-MHC specialization (MEASURED +22%)
**Finding:** ADR-4 in section 20260619T130214Z  
**Measurement:** RGGB-specialized path ~22% faster than generic per-pixel CFA-dispatch.  
**Gate:** flipflop `demosaic-mhc` confirms ≥5% on real ORF/DNG corpus.  
**Effort:** Refactor demosaic_rggb path to separate fast (RGGB) + generic fallback. Needs user approval.

### C4 — pack_rgb16_full redundant pass (src/lib.rs)
**Issue:** Encodes full-res twice (once for output, once for progressive-profile).  
**Suggested:** Fuse or LE-transmute instead of clone.  
**Flipflop:** Measure w/ src/lib.rs export on 12MP full RGB16 encode.

### C5 — unpack_rgb16_le 12MB copy per LookRenderer ctor (src/lib.rs)
**Issue:** LE-transmute opportunity instead of vec allocation.  
**Measurement:** Need flipflop on real tone-slider workflow.

### C6 — rgb_to_rgba scatter (src/lib.rs)
**Issue:** Scalar 3→4 channel spread; SIMD v128 shuffle possible.  
**Flipflop:** `.flipflop/tests/rgb-to-rgba-shuffle.mjs` on 12MP frame.

### C7 — Integer downscale reciprocal multiply (src/lib.rs:1503-1518)
**Issue:** 3 divides/pixel vs precomputed reciprocal.  
**Flipflop:** benchmark 1800→360 (5×) thumbnail.

### C8 — Float downscale x-bounds recompute (src/lib.rs)
**Issue:** Recompute per (dy,dx) vs hoist.  
**Flipflop:** measure on 24MP→4MP float downscale.

### C9 — LookRenderer clone overhead (src/lib.rs ~13MB)
**Issue:** Clones RGB buffer per slider tick; reusable scratch.  
**Measurement:** Profile real tone-slider session.

### C10 — downscale_rgb16_planar SoA SIMD (src/lib.rs)
**Issue:** Horizontal-add opportunity in downscale loop.  
**Flipflop:** Measure on 16-bit thumbnail decode.

---

## CATEGORY D: Deferred — Structural Refactors (ADR-worthy, no auto-edit)

### D1 — Unified TIFF/IFD reader (ADR-1 in section 20260619T130214Z)
**Issue:** read_u16/u32/ascii/IFD-walk triplication across tiff/cr2/dng causes bounds-drift bugs.  
**Suggested:** Shared bounded reader consolidation.  
**Effort:** Requires ownership + cross-file coordination.

### D2 — Unified RawError enum (ADR-2)
**Issue:** Current mix of anyhow/String/bail at decode seam.  
**Suggested:** Typed `RawError` enum.  
**Effort:** Cross-file coordination.

### D3 — Scene-referred RawImageMeta + CR2 colour matrix (ADR-3, HIGH)
**Issue:** Currently drops black/white/iso/bits, collapses camera→XYZ to sRGB at decode (dng.rs:113-123).  
**Suggested:** "Linear, not-tone-mapped" mode + re-enable CR2 per-model colour matrix (cr2.rs:228-240).  
**Effort:** Public struct change; needs your sign-off + cross-layer audit.  
**Related:** [[project-non-riemannian-colour-plan]], [[project-cr2-colordata-matrix-todo]]

### D4 — Fast embedded-preview LOD tier (ADR-6)
**Issue:** CR2+DNG lack fast preview (ORF-only today); `demosaic_rggb_half` AR tier wired.  
**Suggested:** Add CR2/DNG half-res decode path.

### D5 — Collapse 3× SOF3 parsers + 2× BitReaders (ADR-7)
**Issue:** LJPEG parser has duplication.  
**Suggested:** Consolidate.

### D6 — apply_orientation 2/4/5/7 passthrough (000-logic-20/contracts-18/architecture-16)
**File:** pipeline.rs:1701-1713  
**Issue:** EXIF orientations 2/4/5/7 currently no-op (mirror/transpose unimplemented).  
**Suggested patch:** Add mirror_horizontal/mirror_vertical helpers, compose 5/7 as transpose+flip.  
**Gate:** Test corpus with known-orientation files (Olympus ORF rarely uses these).

### D7 — apply_look_params 12 positional f32 args (000-architecture-10)
**File:** pipeline.rs:1643-1694  
**Suggested:** Replace with `LookParams`/`LookDelta` struct.  
**Effort:** Multi-call-site refactor (out of single-file SAFE scope).

---

## CATEGORY E: Deferred — Perceptual Module (Butteraugli/SSIM/PSNR)

**All findings require output parity tests + benchmark evidence per CLAUDE.md.**

### E1 — scale_err accumulator precision (001-logic-1/2/3, avx2/avx512/wasm.rs)
**Issue:** f32 accumulator vs scalar f64 oracle → <1e-4 rel drift on large images.  
**Suggested:** Promote to f64 lanes or periodic reduce.  
**Gate:** Full-resolution parity test + benchmark.

### E2 — PSNR includes alpha; SSIM/butteraugli ignore (001-contracts-5)
**Issue:** Cross-metric inconsistency; documented legacy-JS contract.  
**Suggested:** Drop alpha from PSNR or add to SSIM/butteraugli (breaking change).  
**Effort:** Coordinate across perceptual/mod.rs/avx2.rs.

### E3 — Empty-buffer sentinel divergence (001-contracts-8/001-errors-8/001-errors-11)
**Issue:** ssim returns 0.0, psnr returns +inf, butteraugli returns NaN on np==0.  
**Suggested:** Unify to NaN (reserved for "no data").  
**Effort:** Cross-metric change + ADR.

### E4 — Comparer contracts (001-contracts-1/3/12)
**Issues:**
- Assumes 8-bit RGBA, no range check (colors outside 0..255 yield garbage).
- Metrics return bare f32 with NaN/Inf as undocumented sentinels.
- Force(id) silently maps unknown ids to Scalar.

**Suggested:** ADR — Result<f32,MetricError> + bit-depth parameter + warn/error on unknown forced id.

### E5 — ssim_moments_avx2 is scalar (001-architecture-11)
**Issue:** Named `_avx2` but contains no AVX2 intrinsics; purely for call-site uniformity.  
**Suggested:** Move to ssim.rs as `ssim_moments` (drop feature gate).

### E6 — Reference XYB always scalar; test uses SIMD (001-logic-10)
**Issue:** Injects tiny butterfly on identical image under SIMD backend.  
**Suggested:** Route ref through same SIMD backend or document asymmetry.

### E7 — Fused XYB/SSIM/PSNR/channel-moments (001-performance-1/12)
**Issue:** Walks test buffer ~4 times.  
**Suggested:** Single-read fused kernel.  
**Gate:** Benchmark before fusion (fusible but complex).

---

## Timing Items (Flipflop Candidates)

| Issue | File | Type | Expected Impact | Effort |
|-------|------|------|-----------------|--------|
| C1 (demosaic MHC) | demosaic.rs | perf | +22% | Medium (requires SIMD refactor) |
| C2 (tile endian) | dng.rs | perf | −3.8% (REJECTED) | Low |
| C3 (downscale reciprocal) | pipeline.rs | perf | ? | Low |
| E1 (scale_err precision) | perceptual/simd/*.rs | output-contract | <1e-4 drift | High (parity test) |

---

## Next Steps

1. **Category A (output contracts):** User review → decision on A2/A3/A4 intent.
2. **Category B (colour validation):** Obtain real camera files (Grbg/Bggr DNG, per-channel black, etc.) → run parity tests.
3. **Category C (perf):** Spawn flipflop tests in parallel for C1/C3/C6-10.
4. **Category D (refactors):** Backlog (ADR-level) pending product roadmap.
5. **Category E (perceptual):** Assign to perceptual-specialist agent; measure + unify sentinels.

---

## Agents / Workstreams

**Agent 1: Raw-pipeline colour & output validation**
- Scope: A2, A3, A4, A5, A6, B1–B5
- Model: Sonnet (colour/demosaic reasoning)
- Effort: High (needs user decision + real file validation)
- Output: Questions_raw-pipeline_colour-decision.md

**Agent 2: Performance measurements**
- Scope: C1–C10
- Model: Haiku (flipflop coordination)
- Effort: High (parallel flipflop tests)
- Tools: flipflop, flipflopdom
- Output: Questions_timings.md

**Agent 3: Perceptual module audit**
- Scope: E1–E7
- Model: Opus (complex metric reasoning)
- Effort: Very High (cross-backend parity)
- Output: Questions_perceptual-unification.md

**Agent 4: Structural refactors (backlog)**
- Scope: D1–D7
- Model: Sonnet (architecture)
- Effort: Medium (design-phase only, no implementation)
- Output: QUESTIONS_structural-adrs.md
