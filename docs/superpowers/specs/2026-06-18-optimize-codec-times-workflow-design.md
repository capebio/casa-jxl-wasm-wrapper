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
- **Speed is not the only currency.** A change with **equal or slightly slower** speed is
  acceptable when it **saves memory**, **removes duplication**, or **adds a positive feature**
  (e.g. a slower-but-portable compatibility path kept as an *optional* pathway alongside the
  fast one). A pure regression (slower, no offsetting gain) is rejected. See §5.
- **Alternative pathways are allowed.** An optimizer may *add* a variant pathway rather than
  replace one (fast primary + slower fallback). The slower path is journaled as an
  intentional alternative, not flagged a regression.
- **All layers in scope**, but respect the edit→verify cost gradient: params (no rebuild) ≪
  Rust (`wasm-pack` rebuild) ≪ C++ bridge (emscripten rebuild).
- **Reusable + idempotent:** re-reads a fresh baseline each run; banks only verified diffs.
- Max performance is the objective; token/agent cost is not the limiting factor (Opus xhigh).

## 3. The validation oracle: the `flipflop` skill

Profiling is **cheap** and must be used freely. The oracle is the **`flipflop` skill**
(`docs/superpowers/specs/2026-06-18-flipflop-design.md`) — a standardized interleaved A/B
timing vehicle. Its flip-flop methodology (round-robin `ABAB…` + round start-rotation +
geomean-across-sizes + `trust:low` surfacing) cancels warm-up, frequency, cache and thermal
drift **between arms**, so a median delta is a *definitive* verdict on "is algorithm X faster
than Y," not a noisy estimate. The same harness already proved out as
`StandardMultifileTest.mjs`'s 10-round flip-flop core (lines 471-567).

Consequence: the verify stage needs **no** variance-band heuristics or "re-run 3× and hope."
Verify = author one flipflop **test file** with variant A = baseline, variant B = candidate,
run it, read the journal verdict. Keep iff §5 passes.

This design **assumes flipflop grants the codec-role capabilities** requested 2026-06-18:
1. **async variants** — timed region `await`s the variant (codec encode/decode is async); await
   overhead hits both arms equally so the interleave still cancels it.
2. **quality-magnitude hook** — a per-variant `quality(out, baselineOut) → number` (Butteraugli
   via the existing perceptual kernel) recorded alongside `ms`, so speed and quality are judged
   on the *same* flip. (`equal()` still serves pixel-exact lossless.)
3. **bring-your-own-input** — a custom-corpus / `--inputs` hook feeding real ORF/CR2/DNG/JPG
   assets and raw camera bytes, not just the fractal corpus (RAW decode needs real Bayer files;
   real-photo entropy ≠ fractal entropy).
4. **variant role tag** — `{role:'fallback'|'primary'}` so an intentional alternative pathway is
   journaled as alternative, not a regression.

flipflop also reports **per-flip rss/heap** — this is how the §5 "equal speed acceptable if
memory drops" rule is measured.

- **Params (no rebuild):** variants are two async closures over one loaded module differing only
  in the config object. Cleanest case.
- **Rust / C++ (rebuild):** variants are two closures over two built artifacts (baseline `pkg` ↔
  candidate `pkg`, or two `jxl-core.simd` builds) — same pattern the harness uses to flip
  `simd` ↔ `relaxed-simd-mt`.

## 4. Architecture: layered escalation (A) + tournament graft (C)

Phases ordered by edit→verify cost. Profile data gates the expensive phases. The 3
high-variance metrics get **tournament** optimizers where variance signals headroom;
everything else gets a single optimizer per finding. The tournament's **diversity axis is
the lens panel (§4.5)** — not ad-hoc "angles" — so altitude coverage (including
architecture-level ideas) is guaranteed by construction, not luck.

### 4.5 Optimization lenses (tournament diversity axis)

A **lens** is a mandated viewing altitude. Each tournament optimizer is assigned exactly one
lens and must return findings *from that altitude only*. This forces architecture-level
proposals to exist (the Architecture/Aerial lenses are the **generators** of structurally
different solutions) instead of emerging by accident. flipflop arbitrates which survive.

| Lens | Altitude | Hunts for | Banks via |
|------|----------|-----------|-----------|
| **Aerial** | cross-file / whole-layout | pathways between files & layer sets; redundant marshalling across boundaries; buffer copied→detached→re-materialized; passes fusible across files | speed + §5b dedup/memory |
| **Architecture** | strategic; gross/radical surgery; data & memory model | replace a subsystem; swap memory model (ring buffer, arena, planar↔interleaved); change algorithm *class* | speed or §5b memory/feature |
| **Operational** | loops, nests, algorithms, functions | loop fusion, tiling/blocking for cache, invariant hoisting, pass reduction | speed |
| **Tactical** | low-level code | SIMD lane width, branch removal, LUT, alloc removal, bounds-check elision, fixed-point | speed |
| **Mathematical** | different mathematics | closed-form vs iterative, polynomial/rational approx, separable kernels, integral images, differential/Newton steps, transform-domain (FFT/DCT) | speed (watch §5a quality — approximations are lossy) |

Rules:
- One lens per optimizer agent; the agent's prompt states the lens charter + its example hunts.
- A phase's tournament spins the lenses relevant to that layer (params phase ≈ Mathematical +
  Tactical; Rust/C++ phases ≈ all five; harness ≈ Aerial + Architecture).
- Lenses are **orthogonal to phases**: the same Architecture lens can fire in Rust *and* C++.
- Mathematical-lens outputs are lossy by nature → §5a routes them through the Butteraugli gate,
  never pixel-exact, unless the agent proves algebraic equivalence.
- Lens set is parameterizable via `args.lenses` (default: all five).

### Phase 0 — Profile & Baseline  *(cheap; run freely)*
- Run StandardMultifileTest (full flip-flop). Parse RICH/FLIP lines + history JSON.
- Emit `baseline.json` per file × metric: `{median_ms, dominant_substage, bound_class}` where
  `bound_class ∈ {codec-kernel, marshalling, pipeline}`. `bound_class` **gates Phase 3**
  (enter C++ only when `codec-kernel`).
- Capture per-file **baseline Butteraugli**, **decoded-RGBA hash**, and **baseline rss/heap**
  → regression oracle.
- Seed flipflop inputs: register the StandardMultifileTest assets (8 files) as flipflop's
  bring-your-own corpus (§3 cap. 3), so every later verify runs against real data. Inner-loop
  verifies = a focused flipflop test (one metric, small file subset, few rounds); full
  StandardMultifileTest runs only at phase boundaries.

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

## 5. Gate (shared verify logic)

Two independent checks: a **quality gate** (hard, never relaxed) and an **acceptance test**
(speed *or* an offsetting gain). Both run inside one flipflop test (variant A=baseline,
B=candidate), so speed, quality and memory come from the *same* interleaved flips.

### 5a. Quality gate — hard, mandatory
1. **Classify lossless vs lossy.** Lossless iff `distance===0`, modular-lossless flag set, or
   the change is on the deterministic RAW-decode path. Else lossy.
2. **Lossless →** flipflop `equal(out, baselineOut)` with zero tolerance ⇒ **pixel-identical**
   to Phase-0 baseline (hash match). Any drift = reject.
3. **Lossy →** flipflop `quality(out, baselineOut)` = Butteraugli via the existing perceptual
   kernel (`crates/raw-pipeline/src/perceptual`, native AVX2). Require Δ ≤ `butteraugliThreshold`
   (default 1.0). Reject on exceed.
A candidate failing the quality gate is rejected outright regardless of speed.

### 5b. Acceptance test — speed OR offsetting gain
A candidate that passes 5a is **banked** iff at least one holds, judged on flipflop output:
- **Faster:** flip-flop median `saved_pct > 0` (interleave is the noise control — no variance
  model). OR
- **Equal/slightly slower but leaner:** `saved_pct ≥ −ε` (default ε = 3%) AND per-flip
  `rss/heap` drops materially. OR
- **Equal/slightly slower but simpler:** `saved_pct ≥ −ε` AND the diff removes duplication
  (fewer code paths / shared helper) — agent asserts + cites the dedup; verifier confirms. OR
- **Positive feature:** adds capability (e.g. compatibility fallback) as an **optional/added**
  pathway (`role:'fallback'`), not on the hot path → primary path speed unchanged within ε.
A pure regression (slower, no memory/dedup/feature gain) is rejected.

- Verifier agents are **adversarial**: default to reject. They confirm the asserted offsetting
  gain is real (rss delta from the journal, dedup visible in the diff, fallback truly off the
  hot path) before accepting a non-faster candidate.

## 6. Agent roles

| Phase | Agents |
|-------|--------|
| 0 | 1 profiler (parses bench, writes baseline.json, seeds flipflop inputs) |
| 1 | 1 param finder → tournament optimizers, **one per lens** (per high-var metric) → verifiers |
| 2 | 1 Rust finder → worktree tournament optimizers, **one per lens** (all 5) → 1 integrator → verifiers |
| 3 | 1 C++ finder → ≤3 worktree optimizers (lens-assigned) → verifiers (gated) |
| 4 | 1 synthesis + 1 completeness critic |

## 7. Schemas (StructuredOutput)

- `BASELINE` — `{file, metric, median_ms, dominant_substage, bound_class, baseline_butteraugli, pixel_hash}`
- `FINDING` — `{lens:'aerial'|'architecture'|'operational'|'tactical'|'mathematical', layer, file, location, hypothesis, predicted_gain_pct}`
- `CANDIDATE` — `{diff|config, lossless, role:'primary'|'fallback', predicted_ms, predicted_bytes, claimed_gain:'speed'|'memory'|'dedup'|'feature'}`
- `VERDICT` — `{accepted, accept_reason:'faster'|'leaner'|'simpler'|'feature', flipflop_ms_baseline, flipflop_ms_candidate, saved_pct, rss_delta_mb, quality_ok, pixel_exact, butteraugli_delta, bytes_delta, trust, reason}`

## 8. Reusability (`args`)

`{ targetMetrics?, fileSubset?, layersEnabled?, lenses?, butteraugliThreshold?, rounds?, slowdownEpsilon?, allowFallbacks? }`
Defaults: 3 headline metrics + general enc/dec; all layers; all 5 lenses (§4.5); threshold 1.0;
rounds 10; `slowdownEpsilon` 3% (the ε in §5b); `allowFallbacks` true (permit added alternative pathways).
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

- Workflow runs end-to-end producing a report with per-metric speed/memory deltas vs baseline.
- Every banked change passes the §5a quality gate AND the §5b acceptance test (faster, or
  equal/slightly-slower with a verified memory/dedup/feature gain). No pure regressions banked.
- Depends on the `flipflop` skill providing async variants, a `quality()` hook, bring-your-own
  inputs, and variant role tags (§3). If absent, Phase 0 falls back to a minimal bespoke
  focused harness and logs the degradation.
- Re-running the workflow on already-optimized code banks nothing (idempotent) and reports "no regressions."
- At least the known low-hanging win (wire `tone_simd::apply_tone_bulk` into `process_into`)
  is found, verified, and banked by Phase 2 on first run.
