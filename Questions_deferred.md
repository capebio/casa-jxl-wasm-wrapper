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

## 2026-06-29 — enc_convolve_separable5 edge-coverage (branch perf/enc-conv5-edge-coverage-z3k)

Landed on the branch: scalar-tail Mirror elision, RunOnPool status propagation,
border horiz-dedup, dedicated tiny-height (ysize<=4) kernel, SIMD N/N+1
width-cliff. Deferred (out of this file's scope):

- **Parallelize butteraugli `Blur`** — it calls `Separable5(..., pool=nullptr)`
  (serial), and Blur is the encode bottleneck. A pooled call would help, but the
  pool isn't plumbed into `Blur`; it's a `butteraugli.cc` change, behavioral,
  separate from conv5. Gate: thread the comparator's pool into Blur.
- **In-place `Separable5` variant** — butteraugli guards `&in != out` and uses a
  temp. A delayed-write in-place variant could drop the temp image. New API +
  aliasing contract; not byte-exact-trivial.
- **Weight-family dispatch** (identity / 3-tap / 1-D / separable-3x3) — would skip
  work for degenerate kernels, but needs coefficient telemetry first (NaN /
  signed-zero policy + codesize across Highway targets). No evidence any caller
  passes such kernels.
- **x-tiling for short/wide geometry** — not pursued: the two callers are
  full-image; butteraugli is serial (no pool) and detect_dots has ample
  y-parallelism on full images. Would be dead scheduling complexity here.
