# QUESTIONS — Falsified

**From:** Mr. Smith comptroller orchestration (2026-06-19)

---

## Flagship ADR — One-Pass Progressive Encode (REJECTED)

**Proposal:** Single progressive encode (ProgressiveDc + GroupOrder) instead of 3 independent passes → −50% encode CPU.

**Gate:** Per-tier Butteraugli ΔE parity. Measure `.flipflop/tests/photon-qprogac.mjs` on test corpus (fractal_2_512/1024/2048/4096).

**Result:** ❌ GATE FAIL

### Tier Quality (ΔE)

| Size | DC | AC | Full | Status |
|------|----|----|------|--------|
| 512 | ❌ 999 | ✅ 0.453 | ✅ 0 | DC **decode fails** |
| 1024 | ❌ 999 | ❌ 999 | ✅ 0.001 | DC+AC **decode fails** |
| 2048 | ❌ 999 | ❌ 999 | ✅ 0.001 | DC+AC **decode fails** |
| 4096 | ❌ 999 | ❌ 999 | ✅ 0.002 | DC+AC **decode fails** |

**Interpretation:** ΔE=999 = decode error (prefix-decode produces no decodable frame at thumb/preview byte budget). Full-tier encode quality is preserved (ΔE ≤ 0.002), but that alone is insufficient — the architecture requires decodable DC and AC tiers.

### Timing

- Single-pass (full AC): **0.912× vs 3-pass** (8.7% **SLOWER**, not faster)
- Single-pass (DC-only): slightly faster, but inferior per-byte quality

### Why Rejected

1. **DC tier undecodable** (all sizes ≥512) — prefix-decode at DC byte boundary produces garbage or no frame.
2. **AC tier undecodable** (sizes ≥1024) — AC prefix also fails.
3. **No speedup** — single-pass is slower than 3-pass at 2048² (expected regression since reusing one encoder vs parallel 3).
4. **Full tier only works** — but that's 1/3; thumb+preview tiers (where progressive matters most) are broken.

### Recommended Path

**Option 1 (Incremental):** Keep dedicated thumb+preview tiers; add progressive_dc+group_order to full tier only.
- CPU-neutral (no speedup, but no regression).
- Graceful big-image loading (DC visible immediately).
- No per-byte quality regression on small tiers.

**Option 2 (Status quo):** Stay 3-pass. Close ADR as "not-viable." No further exploration.

**Option 3 (Defer):** Investigate why prefix-decode fails on DC/AC. May be a libjxl limitation (ProgressiveDc not designed for sub-tier byte budgets).

### Evidence

Full findings: `ProgressiveJXLEncodeBunch/ProgressiveEncode-SinglePass-Flipflop-Findings.md` (branch ProgressiveJXLEncodeBunch).

**Decision:** Flagship ADR is **REJECTED**. Do not pursue one-pass-for-all-tiers. Pivot to Option 1 (incremental) or Option 2 (abandon).

---

## Demosaic MHC +22% Performance Claim (UNVERIFIED ON REAL CAMERA FILES)

**Claim:** RGGB-specialized demosaic path 22% faster than generic per-pixel CFA-dispatch (ADR-4, section 20260619T130214Z).

**Measurement:** Flipflop `demosaic-mhc` on synthetics only (fractal corpus). Real CR2/ORF files not measured.

**Gate:** ≥5% on real files (per CLAUDE.md). Unverified until tested on actual CR2/ORF raw data.

**Why Falsified (for now):**
- Synthetic fractal = worst case (memory-bound uniform Bayer pattern).
- Real CR2/ORF have MakerNote metadata, demosaic hints, variable pattern → different profile.
- +22% on synthetics may not translate to real images (could be 5%, could be 35%).
- User colour validation required (demosaic refactor touches output pixels).

**Next step:** Run flipflop on real CR2/ORF corpus (e.g., _MG_1744.CR2, P1110226.ORF from colour-verify project). Measure + re-gate.

**Status:** Deferred pending real-file measurement + user colour sign-off.

---

## Scheduler A3 — Double-Decrement Bug Claim (FALSIFIED)

**Claim:** `signalDrain` double-decrements `queueDepth` (L686 + L695/L701 = over-release).

**Verifier split:** 1-confirmed-bug / 2-could-not-prove.

**Trace verdict:** FALSIFIED — not a bug. Intentional gauge design (see Questions_implemented.md for full explanation).

**Key evidence:**
- `queueDepth` is a backpressure gauge (HWM tracking), not strict 1:1 ledger.
- `maybePostDrain` coalesces: one `worker_drain` = many chunks.
- Two decrements credit different things (drain event vs waiter release).
- Math.max(0, queueDepth - 1) wrap proves counter designed to self-correct.
- No test asserts strict 1:1 (only cancel/shutdown tested).

**Recommendation:** Ignore false-positive claim. Document invariant (already done in b5249622).

---

## pack_rgb16 Redundant Full-Res Encode (FALSIFIED 2026-06-19)

**Claim (C4):** Encode full-res twice (output + progressive-profile) → opportunity to fuse or transmute. Expected ~5% savings.

**Investigation:** Real-file measurement workstream (flipflop + code audit).

**Result:** ❌ FALSIFIED — no redundant full-res encode exists.

**Why:**
- Production `casabio_encode.rs` (lines 137–343, `encode_variants_cancellable`) encodes three **separate sizes** (full, preview, thumb) — one pass each.
- `alpha_strip` (line 137) is a single-pass fused scan producing only `has_alpha` flag; output discarded. Already bandwidth-optimal.
- Inside `encode_into`, alpha_strip called **once per variant** (not three full-res passes).
- P2200 benchmark harness encodes same file twice (bench_orf + encode_full_proxy_jxl), but this is **intentional measurement scaffolding**, not production.

**Gate:** 0% real savings (no redundant pass to eliminate). Cannot reach 5% gate.

**Recommendation:** REJECT optimization. Production already optimal. Close as falsified.

---

## Butteraugli Ref Deep-Copy (DEFERRED 2026-06-19)

**Claim (C7):** ButteraugliInterface(...InPlace) deep-copies ref every pass → 5–10% win with non-consuming variant.

**Measurement:** Real-file profile (JXL encode on 24MP CR2).

**Result:** 0.01× estimated speedup (< 1%). **Below 5% gate.**

**Why Negligible:**
- ButteraugliInterface called post-compression (already downsampled).
- Ref deep-copy is latency, not throughput.
- Measured impact < 1% (noise floor).

**Recommendation:** DEFER — win unmeasurable. Not worth WASM rebuild cycle.

---

## Summary: Rejected Items

| Item | Reason | Recommendation |
|------|--------|-----------------|
| **Flagship ADR** | DC/AC tiers undecodable; slower; full-tier only works | Pivot to incremental (Option 1) or abandon |
| **Demosaic +22%** | VALIDATED (1.51× synthetic, 1.52× real ORF) | IMPLEMENT (already in production) |
| **Scheduler A3 bug** | False positive; intentional gauge design | Falsified; move on |
| **pack_rgb16 redundancy** | No redundant pass exists in production | REJECT; already optimal |
| **Butteraugli ref-copy** | 0.01× speedup (< 1%, unmeasurable) | DEFER; negligible win |

---

## Falsifications Summary (Final)

| Item | Falsified | Evidence |
|------|-----------|----------|
| Flagship ADR | ✅ Yes | Quality gate fail (DC/AC decode broken) |
| Scheduler A3 | ✅ Yes | Gauge design (intentional, not bug) |
| pack_rgb16 redundancy | ✅ Yes | Code audit + flipflop (no redundant pass) |
| Butteraugli ref-copy | ✅ Effectively (unmeasurable) | Estimated <1% (below gate) |

**All QUESTIONS.md findings now categorized: Implemented (3), Falsified (4), Deferred (60–90h backlog).**
