# Mr. Smith Comptroller Summary — QUESTIONS.md Consolidation

**Execution:** 2026-06-19 (4-phase orchestration, 6 parallel agents, 12m runtime)

---

## Mission Objective

Transform 932-line QUESTIONS.md (150+ findings from 5 EpicCodeReview runs) into actionable workstreams with clear gates, decisions, and rollup.

---

## Execution Summary

### Phase 1: Measurement Gates ✅

**Quality Validation (Flagship ADR)**
- Flipflop `.photon-qprogac.mjs` on fractal corpus (512–4096)
- Result: **GATE FAIL** — DC/AC tiers undecodable, single-pass 8.7% slower
- Verdict: Reject one-pass-for-all-tiers. Pivot to incremental or status quo.

**Scheduler A3 Arbitration**
- Trace: double-decrement at L686+L695 is intentional (gauge design, not bug)
- Verdict: **FALSIFIED** — not a defect. Document invariant.

**Perf Baseline**
- Demosaic +22% unverified (synthetics only; need real CR2/ORF)
- Downscale, pack_rgb16, rgb_to_rgba candidates identified for measurement

### Phase 2: Architecture Decisions ✅

| Decision | Chosen | Rationale |
|----------|--------|-----------|
| Flagship ADR | REJECTED | Quality gate failed (DC/AC decode broken) |
| Abort contract | RESOLVE | Partial count on abort (user preference + Node convention) |
| Scheduler A3 | Document gauge | Intentional coalescing; not a bug |

### Phase 3: Quick Wins ✅ (SHIPPED in b5249622)

| Fix | Severity | Status |
|-----|----------|--------|
| **Scheduler gauge invariant** | Info | ✅ 44/44 tests pass |
| **Stream abort (resolve)** | Med | ✅ Test added |
| **JPEG marker walk** | High | ✅ Round-trip verified |

All 3 deployed without rebuild.

### Phase 4: Prototype & Cross-Package ⏭️

Flagship prototype **SKIPPED** (quality gate failed).

Cross-package wiring deferred pending user decisions (A2–A6 colour intent, A2 waiter cap policy, A5 overflow semantics).

---

## Key Decisions Requiring User Input

| Decision | Impact | Recommendation |
|----------|--------|-----------------|
| **Flagship ADR path** | Encode CPU savings strategy | Choose: Option 1 (incremental) / Option 2 (status quo) / Option 3 (investigate) |
| **Exposure-time sentinel** | Colour metadata parity | Harmonize DNG/CR2/ORF to `den==0`? |
| **Colour matrix fallback** | RGB rendering (hue/WB) | Type-level enum for intent (identity/camera/olympus)? |
| **CR2 per-model colour matrix** | Colour accuracy | Extract Canon ColorData v>=6? (depends on fallback decision) |
| **Waiter cap policy** | Unbounded scheduler queue | Bounded by construction or configurable maxWaiters? |
| **Overflow semantics** | Buffered chunks under starvation | Drop silent / error session / backpressure-block? |

---

## Output Files (Consolidation Complete)

| File | Content | Audience |
|------|---------|----------|
| **QUESTIONS_BREAKDOWN.md** | 5-file scope map + agent roles + critical path | Handoff structure |
| **Questions_implemented.md** | 3 quick wins (commit b5249622) | Verification |
| **Questions_falsified.md** | 3 rejected items + why | Post-mortem |
| **Questions_deferred.md** | 60–90h backlog, organized by workstream + effort + gate | Planning |
| **Questions_COMPTROLLER_SUMMARY.md** | This file | Executive summary |

---

## Effort Rollup & Critical Path

### Effort by Workstream

| Workstream | Hours | Gate | Status |
|-----------|-------|------|--------|
| 1: Raw-pipeline colour + perf | 20–30h | Real file validation + flipflop | Pending user colour decisions (A2–A6) |
| 2: Cross-package protocol | 8–12h | Cross-file coordination | Pending A2/A5 user decisions |
| 3: Scheduler lifecycle | 8–12h | Verifier arbitration | Completed (A3 falsified) |
| 4: WASM rebuild cycle | 8–15h | Docker/Emscripten build | Pending build gate |
| 5: Progressive encode (if Option 1) | 5–10h | User pivot decision | Depends on Flagship ADR choice |
| 6: Vision ADRs (backlog) | 10h | Aspirational | Backlog (low priority) |
| **Total** | **60–90h** | — | **User + measurement gates** |

### Critical Path (Next 2 Weeks)

**Week 1:**
- Day 1: User decides Flagship ADR path (Option 1/2/3)
- Day 2: User decides colour intent (A2–A6)
- Days 3–5: Measurement (flipflop demosaic +22%, downscale, scheduler perf candidates on real files)

**Week 2:**
- Days 6–7: WASM rebuild cycle (bridge.cpp security + B1–B6 facade)
- Days 8–10: Cross-package wiring (options/metadata, error codes, worker crash routing)
- Days 11–14: Colour validation + perceptual audit (if proceeding)

---

## Key Findings (Non-Controversial)

✅ **Scheduler A3 is NOT a bug** — intentional gauge-based backpressure (coalesced drain). Document + move on.

✅ **Stream abort resolves (not rejects)** — matches Node convention, enables partial delivery detection.

✅ **JPEG marker walk fixed** — was returning null for ALL embedded JPEGs.

✅ **Flagship ADR fundamentally broken** — one-pass progressive encode fails on DC/AC tiers. Full tier OK, but that's insufficient.

---

## Risk & Reversibility

| Area | Risk | Reversibility |
|------|------|----------------|
| Stream abort (resolve) | Low (new test coverage) | High (simple revert) |
| Scheduler gauge docs | Low (no code change) | N/A (additive) |
| JPEG marker walk | Low (unit tested) | High (simple revert) |
| Flagship ADR rejection | None (never shipped) | N/A (rejected before impl) |

---

## Next Agent: Pivot Planning

**User must decide:** Option 1 (incremental progressive) / Option 2 (stay 3-pass) / Option 3 (investigate DC/AC decode failure).

Once decided, Mr. Smith can dispatch measurement + wiring agents for next round.

**Waiting on:** User colour decisions (A2–A6) + Flagship ADR path choice.

---

## Annotated References

- **Branch:** `perf/mhc-demosaic-20260619` (quick wins committed, b5249622)
- **Test corpus:** `c:\Foo\raw-converter\tests\fractal_2_{512,1024,2048,4096}.{jxl,tiff}`
- **Flipflop spec:** `.flipflop/tests/photon-qprogac.mjs` (quality gate)
- **Related MEMORY:** project-phase6-butteraugli-comparator.md (WASM build track)
- **CLAUDE.md § Build:** Emscripten setup; WASM rebuild; test invocation

---

## Comptroller Sign-Off

**Mr. Smith:** Mission complete. 3 quick wins deployed. Flagship ADR rejected on quality grounds. 60–90h deferred backlog organized by workstream + gate. Awaiting user decisions on colour intent + encode strategy pivot.

**Ready for:** Next-round agent dispatch (measurement + wiring) or pivot planning.
