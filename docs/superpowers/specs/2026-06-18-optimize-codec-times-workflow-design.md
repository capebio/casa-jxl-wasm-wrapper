# Design: `optimize-codec-times` — reusable Opus-xhigh optimization workflow

Date: 2026-06-18
Status: approved (architecture A + tournament graft), pending spec review
Author: David + Claude (Opus 4.8, xhigh)

## 1. Goal

A reusable `Workflow` script that slashes JXL encode/decode and RAW-decode times
across **all layers** (encoder params/flags, RAW pipeline Rust, libjxl bridge C++,
benchmark/marshalling harness), banking **only** changes that pass the quality gate.
Every run is measured against `StandardMultifileTest.mjs` — the existing benchmark is
both the profiler and the regression oracle.

Primary targets (highest variance ⇒ most headroom):
- **PhotonProgEnc** — `encodeJxlVariant(..., {progressive:true, photonNoiseIso:800})` (StandardMultifileTest.mjs:666)
- **ModularProgEnc** — `encodeJxlVariant(..., {progressive:true, modular:1})` (:662)
- **RAW Decode** — `process_{orf,cr2,dng}_with_flags` (:427-429), substages `decompress/demosaic/tonemap/orient`

Secondary: general `prog_enc`, `shot_dec`, `shot_enc`, first/final paint, pyramid/JXTC encode.

## 2. Constraints

- **Quality gate is non-negotiable:** lossless paths must stay **pixel-exact**; lossy paths
  must stay within a **Butteraugli** threshold (default absolute Δ ≤ 1.0 vs baseline).
- **All layers in scope**, but respect the edit→verify cost gradient: params (no rebuild) ≪
  Rust (`wasm-pack` rebuild) ≪ C++ bridge (emscripten rebuild).
- **Reusable + idempotent:** re-reads a fresh baseline each run; banks only verified diffs.
- Max performance is the objective; token/agent cost is not the limiting factor (Opus xhigh).

## 3. The validation oracle: flip-flop A/B is definitive

Profiling is **cheap** and must be used freely. The harness already implements a
**flip-flop benchmark** (StandardMultifileTest.mjs:471-567): 10 interleaved rounds, block
of all files under arm A, then arm B, repeat; report **per-metric medians + speedup ratio**.
Interleaving controls warm-up, CPU frequency, cache state and thermal drift **between the two
arms** — so a median delta from a flip-flop run is a *definitive* verdict on "is algorithm X
faster than algorithm Y," not a noisy estimate.

Consequence for this design: the verify stage does **not** need variance-band heuristics or
"re-run 3× and hope." Verify = run a flip-flop with arm A = baseline, arm B = candidate;
keep iff arm B median is faster by more than rounding AND the quality gate holds.

- **Params (no rebuild):** flip-flop alternates encoder configs in-process. Cleanest — both
  arms share one loaded module; only the config object differs.
- **Rust / C++ (rebuild):** flip-flop alternates two built artifacts (baseline `pkg` ↔
  candidate `pkg`, or two `jxl-core.simd` builds), exactly as the harness already alternates
  `simd` ↔ `relaxed-simd-mt` via `setForcedTier` + module reload.

## 4. Architecture: layered escalation (A) + tournament graft (C)

Phases ordered by edit→verify cost. Profile data gates the expensive phases. The 3
high-variance metrics get **tournament** optimizers (N agents, distinct angles) where
variance signals headroom; everything else gets a single optimizer per finding.

### Phase 0 — Profile & Baseline  *(cheap; run freely)*
- Run StandardMultifileTest (full flip-flop). Parse RICH/FLIP lines + history JSON.
- Emit `baseline.json` per file × metric: `{median_ms, dominant_substage, bound_class}` where
  `bound_class ∈ {codec-kernel, marshalling, pipeline}`. `bound_class` **gates Phase 3**
  (enter C++ only when `codec-kernel`).
- Capture per-file **baseline Butteraugli** and **decoded-RGBA hash** → regression oracle.
- Write `benchmark/bench-focused.mjs`: imports the same encode/decode helpers, runs ONE
  metric on a small file subset over a configurable round count, returns flip-flop medians.
  Inner-loop verifies use this; full suite runs only at phase boundaries. (Harness change — in scope.)

### Phase 1 — Encoder params  *(no rebuild; fastest loop)*
- Finder reads `facade.ts` / `encode-handler.ts` → enumerates every exposed knob
  (distance, effort, progressive flavor, photonNoiseIso, modular flags, chunk size, tier).
- **Tournament** for {Photon, Modular, prog_enc}: N optimizers, each a distinct hypothesis /
  region of param space → focused flip-flop (config A=baseline vs B=candidate) →
  `{ms, bytes, butteraugli, lossless?}`.
- Gate per config (see §5). Bank winners as config changes. Loop-until-dry.

### Phase 2 — RAW pipeline (Rust)  *(one rebuild barrier)*
- Phase 0 names the dominant substage per format. Finder scans `crates/raw-pipeline` for SIMD
  gaps, alloc churn, scalar loops. Known low-hanging: `apply_tone_math` ≈70% cost center;
  SIMD `tone_simd::apply_tone_bulk` exists on a branch but is **not wired** into `process_into`.
- **Tournament optimizers in worktrees** (parallel, isolated) — distinct angles: SIMD widen,
  parallelize, algorithm swap, alloc removal — each returns a diff + predicted gain.
- **Integrator** applies non-conflicting winning diffs → **single** `wasm-pack`/`build-parallel-wasm.ps1`
  rebuild → flip-flop (baseline pkg ↔ candidate pkg) + `cargo test --no-default-features --lib`
  (run from `crates/raw-pipeline`) + **pixel-exact** RAW-decode check. Conflicts → sequential fallback.
- Gate: RAW decode deterministic ⇒ pixel-exact required. Keep only pixel-exact AND flip-flop-faster.

### Phase 3 — libjxl bridge (C++)  *(gated, heaviest)*
- Entered **only if** Phase 0 marks the metric `codec-kernel`-bound.
- Finder scans `bridge.cpp` + `external/libjxl` for the specific path (photon-noise synth,
  modular encode, progressive AC).
- Optimizers in worktrees → emscripten rebuild barrier → flip-flop A/B + quality gate + full lib test.
- Risk control: cap candidates ≤ 3; **log every dropped candidate** (no silent truncation — CLAUDE.md).

### Phase 4 — Synthesis & report
- Re-run **full** StandardMultifileTest with all banked changes. Compare vs Phase-0 baseline:
  per-metric speedup, quality Δ, byte Δ.
- **Completeness critic** agent: what wasn't tried, what regressed, what is deferred → QUESTIONS-style list.
- Write report + **revert manifest** (each change isolated → user cherry-picks).

## 5. Quality gate (shared verify logic)

For each candidate:
1. **Classify lossless vs lossy.** Lossless iff `distance===0`, modular-lossless flag set, or
   the change is on the deterministic RAW-decode path. Else lossy.
2. **Lossless →** decode output, hash RGBA, require **pixel-identical** to Phase-0 baseline hash.
3. **Lossy →** compute Butteraugli via the existing perceptual kernel
   (`crates/raw-pipeline/src/perceptual`, native AVX2). Require Δ ≤ `butteraugliThreshold`
   (default 1.0) relative to baseline.
4. **Speed →** flip-flop A/B median: candidate must beat baseline. No separate noise model —
   the flip-flop interleaving is the noise control (§3).
- Verifier agents are **adversarial**: their job is to *reject*. A candidate survives only if
  the flip-flop median is faster AND the quality check passes.

## 6. Agent roles

| Phase | Agents |
|-------|--------|
| 0 | 1 profiler (parses bench, writes baseline.json + bench-focused.mjs) |
| 1 | 1 param finder → N tournament optimizers (per high-var metric) → verifiers |
| 2 | 1 Rust finder → N worktree tournament optimizers → 1 integrator → verifiers |
| 3 | 1 C++ finder → ≤3 worktree optimizers → verifiers (gated) |
| 4 | 1 synthesis + 1 completeness critic |

## 7. Schemas (StructuredOutput)

- `BASELINE` — `{file, metric, median_ms, dominant_substage, bound_class, baseline_butteraugli, pixel_hash}`
- `FINDING` — `{layer, file, location, hypothesis, predicted_gain_pct}`
- `CANDIDATE` — `{diff|config, lossless, predicted_ms, predicted_bytes}`
- `VERDICT` — `{is_real, flipflop_ms_baseline, flipflop_ms_candidate, speedup, quality_ok, pixel_exact, butteraugli_delta, bytes_delta, reason}`

## 8. Reusability (`args`)

`{ targetMetrics?, fileSubset?, layersEnabled?, butteraugliThreshold?, rounds? }`
Defaults: 3 headline metrics + general enc/dec; all layers; threshold 1.0; rounds 10.
Each run reads a fresh baseline and banks only verified diffs → safe to re-run.

## 9. Risks → mitigations

| Risk | Mitigation |
|------|-----------|
| Thermal / measurement noise (real ~1.5× thermal artifact seen before) | flip-flop interleaving is the control; same-process A/B for params; pin power plan |
| Rebuild cost dominates wall time | C++ phase gated by bound_class; Rust diffs batched to one rebuild |
| Parallel diffs conflict | worktree isolation + integrator dedup; sequential fallback |
| Pixel drift in RAW decode | pixel-exact gate hashes decoded RGBA |
| Silent coverage caps | log every dropped/​deferred candidate (Phase 3 cap, file subset) |

## 10. Out of scope (this spec)

- Auto-committing banked changes (workflow writes a revert manifest; user lands them).
- New benchmark *metrics* beyond what StandardMultifileTest already emits.
- GPU / WebGPU codec paths.

## 11. Success criteria

- Workflow runs end-to-end producing a report with per-metric speedups vs baseline.
- Every banked change passes the §5 gate (pixel-exact lossless / Butteraugli lossy) and a
  flip-flop median speedup.
- Re-running the workflow on already-optimized code banks nothing (idempotent) and reports "no regressions."
- At least the known low-hanging win (wire `tone_simd::apply_tone_bulk` into `process_into`)
  is found, verified, and banked by Phase 2 on first run.
