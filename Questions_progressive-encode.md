# QUESTIONS — progressive-encode ecosystem (scheduler, profile, encode pipeline)

**Source:** EpicCodeReview 20260619T093126Z (src/lib.rs) + 20260619T130329Z (ProgressiveJXLEncodeBunch)

## Scope
This file consolidates findings for **progressive JXL encode architecture**:
- `packages/jxl-progressive/src/progressive-scheduler.ts` — Job scheduling, scoring, retry, prefetch
- `packages/jxl-progressive/src/progressive-profile.ts` — Tier profiling (DC/AC/full), byte offset computation
- `crates/raw-pipeline/src/casabio_encode.rs` — RGB16 encode variant (full/preview/thumb), progressive fan-out
- `crates/casaencoder/src/lib.rs` — User-facing encode API
- Cross-concerns: tier-fetch orchestration, manifest generation, progressive profile derivation

## Handoff Strategy
**Subagent type:** General (architecture + timing)  
**Model:** Sonnet (scheduling + encode pipeline reasoning)  
**Effort:** High (flagship ADR + measured perf items + cross-file coordination)

---

## FLAGSHIP ADR (HIGHEST LEVERAGE — Directly Cuts Encode Time)

### ADR-Flagship — Single-Pass Progressive Encode (instead of three independent passes)
**Source:** `.epiccodereview/20260619T130329Z/global/adr_draft/single-pass-progressive-encode.md`

**Current state:** 3 independent libjxl `Encoder` passes (full-res, profile DC, profile AC) → 3× encode-CPU.

**Proposed:** One progressive `Encoder` (ProgressiveDc + GroupOrder) emitting byte offsets → retire `profileJxl` post-encode re-decode.

**Expected savings:**
- Encode CPU: ~66% (2/3 reduction, sequential 3-pass → 1 pass).
- Storage: varies (depends on progressive encoding efficiency vs 3-tier separate files).
- Ingest throughput: +50–100% (eliminate re-decode decode of full file for profiling).

**Gate (CRITICAL):**
- Per-tier Butteraugli/ΔE must hold (quality parity).
- Measure with existing `.flipflop/tests/photon-qprogac.mjs`.
- Coordinate with `.verify-quality` sibling test.

**Reversibility:** 
- Partial (output format changes: single .jxl with progressive hints instead of 3 separate .jxl files).
- Migration needed (existing manifest format may need versioning).

**Risk:** 
- High (storage format + encode output semantics).
- NOT auto-applied without sign-off.

**Recommended next step:**
1. Run `.flipflop/tests/photon-qprogac.mjs` to confirm tier quality holds.
2. Sketch migration/versioning for manifest format.
3. Prototype in a feature branch (don't merge until user review).

**Effort:** 8–12h (design + implementation + testing).

**Impact:** If approved, this is the single biggest timing win (cuts encode time in half).

---

## CATEGORY A: Architecture Opportunities (ADR-worthy, deferred pending decision)

### A1 — Three concurrent single-threaded encoders vs one progressive encoder (casabio_encode.rs)
**Finding:** Current: rayon fan-out of 3 independent `Encoder` instances (full, preview, thumb) running concurrently under parallel feature.

**With flagship ADR:** One progressive encode eliminates 3-way fan-out. Parallel feature becomes unnecessary for encode (but may still be needed for input RGB16 processing).

**Suggested:** After flagship ADR approved, audit whether parallel feature is still needed; consider feature-gating encode parallelism separately from preprocessing.

**Effort:** 1h (once flagship ADR decided).

### A2 — WASM-side progressive encode bridge (jxl-ffi/crates/jxl-ffi/src/lib.rs)
**Finding:** No in-scope WASM-side progressive-encode FFI. Browser path can't produce progressive JXL today (only decode).

**Decision needed:** Where does WASM progressive encode live?
- Option 1: Implement in facade.ts/bridge.cpp (full encode in browser).
- Option 2: Browser compresses to full .jxl locally; server does progressive tier derivation.
- Option 3: Defer (server-side only for now).

**Effort:** Depends on option (5–20h for Option 1).

### A3 — Unbounded prefixAccum buffer (progressive-scheduler.ts:605)
**Finding:** Full JXL accumulates in memory with no upper bound.

**Suggested:** Designed memory budget (e.g., 256 MB cap), spill to disk if exceeded.

**Effort:** 3–5h (depends on spill strategy).

### A4 — Double-scan SHA-256 (progressive-profile.ts:191)
**Finding:** `computeSha256` scans `jxlBytes` sequentially AFTER profiling. Fused with profiling pass or off-hot-path.

**Suggested:** Fuse into profile loop or move to post-ingest batch hash.

**Effort:** 1h (fusion), 2h (separate batch).

---

## CATEGORY B: Cross-File Issues (Deferred — confirmed, not auto-fixed)

### B1 — byteStart dead field (progressive-manifest.ts ManifestTier)
**Finding:** `byteStart` always written 0, never read (consumer uses cumulative `bytes=0-byteEnd`).

**Current state:** Public schema (removing breaks consumers).

**Suggested patch:** Decide alongside flagship (if one-pass progressive encode lands, offset layout changes anyway).

**Effort:** 0 (wait for flagship ADR decision).

### B2 — Manifest double-fetch race (progressive-scheduler.ts:428)
**Finding:** `prefetchManifest` and `startDecode` can both fetch the manifest for the same job.

**Current state:** PARTIALLY mitigated by local-capture TOCTOU fix (landed). But duplicate-fetch dedup itself unaddressed.

**Suggested patch:** Track in-flight manifest promise per job; share it.

**Effort:** 1h.

### B3 — DC tier byteEnd can exceed full file size (progressive-profile.ts:156)
**Finding:** Set to `bytesPushed` at frame event; can reach/exceed full file size.

**Status:** Pre-existing bug (schedule TS errors masked it). Now exposed by test failure `profile.test.ts:86` ("dc tier byteEnd is less than full file size" FAILS 1/86).

**Suggested patch:** Cap `dcTierByteEnd = min(bytesPushed, fullFileSize - 1)`.

**Effort:** 0.5h (quick fix) + root-cause analysis (may tie to flagship ADR).

---

## CATEGORY C: Scheduling Perf Items (Measured; deferred per gate)

**Gate: ≥5% speedup + test suite green.**

### C1 — tick() re-sorts candidates every RAF (progressive-scheduler.ts:484)
**Status:** DEFERRED Q1 (from section pass)

**Measurement:** 73–80% speedup on sort at 200–500 jobs (38 µs → 10 µs median).

**Why deferred:** Requires dirty-state tracking across all state-change methods; risk of missing `decoderAbort` transitions → next tick would attempt second decode for same job.

**Implementation sketch:** Add `private candidatesDirty = true` field; set true in observe/unobserve/select/deselect/handleIntersection/startDecode.finally; in tick(), if `!candidatesDirty`, recompute scores in-place + re-sort (starvationBonus time-dependent, always update).

**Gate:** ≥5% faster at 200 jobs AND test suite green (scheduler.test.ts lines 503, 545, 602).

**Effort:** 2h (implementation) + 1h (testing).

### C2 — armEarliestRetryTimer incremental tracking (progressive-scheduler.ts)
**Status:** DEFERRED Q2

**Measurement:** 97% speedup (3.4 µs → 0.1 µs). Absolute cost tiny; guard (`if (armedRetryAt === earliest && retryTimerId !== null) return`) already O(1).

**Recommendation:** Not worth implementing (net gain marginal; guard handles fast path). **CLOSE.**

### C3 — teeFetch tee() double-buffering (progressive-scheduler.ts:454)
**Status:** DEFERRED Q3

**Finding:** `ReadableStream.tee()` buffers up to 1 full tier in memory when decoder stalls. For 10 MB tier = 20 MB peak.

**Suggested fix:** Replace with in-line `TransformStream` (zero extra buffering).

**Gate:** Measure actual P95 tier sizes in production. If P95 < 2 MB, 2× = 4 MB (not worth complexity). If P95 10+ MB, worth doing.

**Effort:** 2–3h (if pursued).

### C4 — Synchronous full-bytes SHA-256 (progressive-profile.ts:700)
**Status:** DEFERRED (related to C3; threading change)

**Suggested:** Fuse with profile scan or move to separate batch.

**Effort:** 1h (fusion) + flipflop (measure impact).

---

## CATEGORY D: Quality & Correctness

### D1 — Per-tier Butteraugli/ΔE parity (flagship ADR gate)
**Measurement tool:** `.flipflop/tests/photon-qprogac.mjs`

**Required:** Three DC/AC/full tiers from one progressive encode must match three independent-encode tiers in ΔE (within tolerance).

**Test data:** Existing `.flipflop/tests/corpora` (real images, no synthetic only).

**Effort:** 1–2h (run flipflop, validate results).

### D2 — progressive-profile.ts pre-existing test failure (now exposed)
**File:** `packages/jxl-progressive/test/profile.test.ts:86`

**Test:** "dc tier byteEnd is less than full file size"

**Status:** Pre-existing bug hidden by TS compile errors (now fixed, test runs + FAILS).

**Impact:** DC tier can exceed file size, breaking `selectTiers` heuristic.

**Suggested patch (quick fix):** Cap `dcTierByteEnd = min(bytesPushed, fullFileSize - 1)`.

**Effort:** 0.5h + root-cause analysis.

---

## CATEGORY E: Vision Opportunities (Aspirational, ADR-level)

### E1 — ManifestTier LOD metadata (pixel width/height)
**Finding:** No per-tier width/height → ML sizing, AR, pyramid LOD need to decode header or guess.

**Suggested:** Add to schema + emit from encoder.

**Effort:** 2h (schema + emit).

### E2 — TierFetchOptions timeoutMs (AR deadline enforcement)
**Finding:** No timeout mechanism for DC-tier recognition pass.

**Suggested:** Add `timeoutMs` backed by `AbortSignal.timeout()`.

**Effort:** 1h.

### E3 — Typed perceptual passthrough (manifest schema)
**Finding:** `perceptual: Record<string,unknown>` — no contract for LookRenderer/Perceptual Constancy metadata.

**Suggested:** Define typed schema once Perceptual Constancy is integrated.

**Effort:** 2h (once that feature ships).

### E4 — onManifest as ML-dispatch point + render-budget signaling
**Finding:** `onManifest` could surface tier-resolution + predicted-arrival + render-budget hints to game engines / AR apps.

**Suggested:** Extend ProgressiveImageJob with `timeToFirstPixelMs`, `fairnessScore` → render-budget signal.

**Effort:** 3h (design + implementation).

### E5 — Per-frame byte offsets in progressive manifest
**Finding:** `streamTierFrames` discards per-frame byte offsets (only tier-level available).

**Suggested:** Emit frame boundaries for sub-tier seeking.

**Effort:** 2h (encoder instrumentation).

---

## CATEGORY F: Test Gaps

### F1 — Profile test failure: Q4 (pre-existing, now exposed)
**Status:** Already noted in B3 above.

**File:** `packages/jxl-progressive/test/profile.test.ts:86`

**Recommended next step:** Quick fix (cap byteEnd) + separate bug report (root cause of excessive byteEnd).

### F2 — testFetchTierWithPrefix TS workaround (exact-optional-property-types)
**Status:** DEFERRED Q5

**Current:** Cast `(this as any).testFetchTierWithPrefix = (opts as any).testFetchTierWithPrefix`.

**Clean fix:** Change field declaration to `private testFetchTierWithPrefix: typeof fetchTierWithPrefix | undefined = undefined` (not optional syntax, explicit union). Then assignment valid without cast.

**Effort:** 0.5h.

---

## Timing Items (Flipflop Candidates)

| Item | File | Type | Expected Impact | Effort |
|------|------|------|-----------------|--------|
| Flagship (1-pass encode) | casabio_encode.rs | game-changer | −50% encode CPU | 12h design+impl |
| C1 (tick dirty-flag) | progressive-scheduler | perf | 73% sort, ~5–10% overall | 3h |
| C3 (tee buffering) | progressive-scheduler | perf | Tier-size dependent (measure first) | 3h |
| C4 (fused SHA) | progressive-profile | perf | Tier-scan dependent | 1h |
| B3 (byteEnd cap) | progressive-profile | correctness | Fixes test failure | 0.5h |

---

## Next Steps

**Phase 1 (Quick fixes — 1h):**
- B3: Cap dcTierByteEnd (fix test failure).
- F2: Clean up exact-optional-property-types cast.

**Phase 2 (Measurement gate — 2h):**
- Run `flipflop/tests/photon-qprogac.mjs` to validate flagship ADR quality gate.
- Measure actual tier sizes in production (decide C3 pursuit).

**Phase 3 (Flagship ADR decision — user call):**
- Prototype one-pass progressive encode in feature branch.
- Coordinate manifest format migration.
- Decide reversibility strategy (version field, dual-mode decoder, etc.).

**Phase 4 (Performance optimizations — if gate met, 5–8h):**
- C1: Dirty-flag optimization (if 5% gate confirmed).
- C3/C4: Reduce buffering + fuse SHA (if tier-size data justifies).

**Phase 5 (Vision features — backlog, 8–12h):**
- E1–E5: LOD, timeouts, typed perceptual, ML dispatch, per-frame offsets.

---

## Agents / Workstreams

**Agent 1: Quality validation & quick fixes**
- Scope: D1 (flipflop validation), B3 (byteEnd cap), F2 (TS cast)
- Model: Haiku (straightforward)
- Effort: 2–3h
- Output: Test validation report + quick fixes

**Agent 2: Flagship ADR prototype**
- Scope: Design one-pass progressive encode, manifest format versioning
- Model: Opus (architecture + encode pipeline)
- Effort: 5–8h (design phase, optional prototype)
- Output: ADR document + optional proof-of-concept

**Agent 3: Performance measurements**
- Scope: C1, C3, C4 (measure + decide gate)
- Model: Haiku (flipflop coordination)
- Effort: 3–4h
- Output: Flipflop results + recommendations (Questions_timings.md)

**Agent 4: Architecture coordination**
- Scope: A1–A4 (decide, coordinate with other modules)
- Model: Sonnet
- Effort: 3–4h
- Output: Architecture decisions + dependencies doc

**Agent 5: Vision features (backlog)**
- Scope: E1–E5 (backlog ADR drafts)
- Model: Haiku (templates)
- Effort: 3h
- Output: Vision ADR drafts (no implementation)

---

## Related Tasks (Coordination)

See also:
- **Questions_raw-pipeline.md § C1:** Demosaic +22% perf (MHC specialization) — coordinate with encode variants.
- **Questions_jxl-wasm.md § C7:** Butteraugli ref deep-copy (5–10% encode speedup) — complement to flagship ADR.
- **Questions_jxl-worker.md § D2:** Early-complete session cancellation — affects scheduler prefetch efficiency.

---

## Summary

**Flagship ADR is the highest-leverage win** (−50% encode CPU if quality holds). Everything else is secondary optimization.

**Critical path:**
1. Validate quality gate (flipflop 2h).
2. User approval (async, ~1d).
3. Prototype + land (12h, feature branch).
4. Migrate ingest pipeline (TBD, depends on manifest versioning).

**Secondary perf:** C1 (73% sort win) if 5% overall gate confirmed.

**Risk:** Medium (storage format change; requires migration). Reversibility depends on manifest versioning strategy.
