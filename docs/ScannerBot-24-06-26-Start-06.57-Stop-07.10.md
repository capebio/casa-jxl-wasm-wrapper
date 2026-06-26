---
scannerbot: 1
run_id: 24-06-26-0657
start: 2026-06-24T06:57Z
stop: 2026-06-24T07:10Z
mode: inline
sweep_categories: [C, D, E, F]
target_root: external/libjxl-012/lib/jxl/enc_group.cc
branch: scannerbot/24-06-26-encgroup            # SUBMODULE worktree branch (off perf/acs-entropy-cleanups)
worktree: C:/Foo/rcw-sb-encgroup                # submodule worktree (target is a nested git repo)
tally: {arch: 0, perf: 4, mem: 0, bug: 0, correctness: 0, maint: 1, seam: 0, misc: 0}
disposition: {direct_fix: 1, adr_draft: 0, defer: 4, dropped_X: 0}
files_swept: 1
findings_total: 5
pipeline_estimate_pct: -1.3                      # rolling Amdahl SUM (ESTIMATE, native-AVX2 only — see note)
---

# Scannerbot Run 24-06-26-0657

| Run | Start | Stop | Duration | Files | Findings | direct_fix / adr / defer / dropped_X |
|-----|-------|------|----------|-------|----------|--------------------------------------|
| 24-06-26-0657 | 06:57 | 07:10 | 13m | 1 | 5 | 1 / 0 / 4 / 0 |

**Run tally:** arch 0 · perf 4 · mem 0 · bug 0 · correctness 0 · maint 1 · seam 0 · misc 0
**Sweep:** Category C + D + E + F on `external/libjxl-012/lib/jxl/enc_group.cc` · overlays V, X always on · mode=inline

> **Run-shape note (user-scoped).** User asked for: review this one file by a single reviewer
> (not EpicCodeReview), "interleave A/B flipflop where performance is concerned, wire in
> one-time then perform test once." So: **one** flipflop harness, **one** measurement run — not
> the standard sweep-to-diminishing-returns loop (MIN_SWEEPS=2 etc. deliberately not applied).
> One perf finding was carried to the gate; the rest are recorded as defer/note.
>
> **Isolation note.** Target is a file in the `external/libjxl-012` **submodule** (its own git
> repo, currently on branch `perf/acs-entropy-cleanups` with unrelated WIP in enc_ans_params.h /
> enc_modular_simd.cc — enc_group.cc was clean). The superproject-oriented `scannerbot-init.ps1`
> would checkout the submodule at the pinned gitlink (detached, wrong branch), so instead a
> **submodule worktree** `C:/Foo/rcw-sb-encgroup` was cut on branch `scannerbot/24-06-26-encgroup`
> from `perf/acs-entropy-cleanups`. Live submodule tree untouched. Ledger lives in superproject
> `docs/` (uncommitted, for review). **Never pushed.**

---

## File 001 — `external/libjxl-012/lib/jxl/enc_group.cc`

<!-- section-state: {started: 2026-06-24T06:57Z, ended: 2026-06-24T07:10Z,
     tally: {arch:0, perf:4, mem:0, bug:0, correctness:0, maint:1, seam:0, misc:0},
     findings: 5, lines_scanned: 534} -->

**Section tally:** arch 0 · perf 4 · maint 1 — 5 findings · scanned 534 LOC
**Section time:** 06:57 → 07:10
**Commit:** `a4716392` (submodule worktree branch `scannerbot/24-06-26-encgroup`)

Roles in this TU: `QuantizeBlockAC` (SIMD AC-coeff quantizer, hot per-block×channel),
`AdjustQuantBlockAC` (scalar adaptive-quant adjust, **effort≥5 only** — e3/kFalcon skips it via
`QuantizeRoundtripYBlockAC`'s `speed_tier <= kHare` gate), `QuantizeRoundtripYBlockAC` (Y roundtrip),
`ComputeCoefficients` (per-group driver: DCT → DC → roundtrip-quant → colour-unapply → quant X/B),
`EncodeGroupTokenizedCoefficients` (HWY_ONCE token writer). EncodeGroups/VarDCT ≈ 28–33% of e3
encode per prior profiling — this file is genuinely on the hot path.

### perf

#### 001-E4-qbac · perf · E4 invariant hoist (+ D kernel) — **LANDED**
- **where:** `lib/jxl/enc_group.cc:78-101` (QuantizeBlockAC inner loop)
- **lens:** E4 (loop-invariant hoist) / D (kernel) · matched_lens: E4
- **disposition:** direct_fix
- **change_class:** perf (integer-stable — no FP reassociation; identical vectors, just hoisted)
- **severity:** medium
- **what:** For the dominant wide-vector case (`xsize==1 && Lanes(df) >= kBlockDim`, i.e. AVX2 /
  AVX-512-capped-8), the per-quadrant threshold vectors are loop-invariant. Build the column mask +
  the two per-row-half threshold vectors **once** before the y-loop instead of re-loading the mask
  and re-broadcasting thresholds on every row. Narrow lanes (wasm SIMD128 N=4, SSE) and large blocks
  keep the original general path unchanged.
- **before:** ```cpp
  for (size_t y = 0; y < ysize * kBlockDim; y++) {
    ...
    for (size_t x = 0; x < xsize * kBlockDim; x += Lanes(df)) {
      auto threshold = Zero(df);
      if (xsize == 1) {
        HWY_ALIGN uint32_t kMask[kBlockDim] = {0,0,0,0,~0u,~0u,~0u,~0u};
        const auto mask = MaskFromVec(BitCast(df, Load(du, kMask + x)));
        threshold = IfThenElse(mask, Set(df, thresholds[yfix+1]), Set(df, thresholds[yfix]));
      } else { ... }
      ... // quant math
    }
  }
```
- **after:** ```cpp
  if (xsize == 1 && Lanes(df) >= kBlockDim) {
    HWY_ALIGN static const uint32_t kMask[kBlockDim] = {0,0,0,0,~0u,~0u,~0u,~0u};
    const auto mask = MaskFromVec(BitCast(df, Load(du, kMask)));
    const auto thr_top = IfThenElse(mask, Set(df, thresholds[1]), Set(df, thresholds[0]));
    const auto thr_bot = IfThenElse(mask, Set(df, thresholds[3]), Set(df, thresholds[2]));
    for (size_t y = 0; y < ysize * kBlockDim; y++) {
      const size_t yfix = static_cast<size_t>(y >= ysize * kBlockDim / 2) * 2;
      const size_t off = y * kBlockDim;            // xsize == 1
      const auto threshold = (yfix == 0) ? thr_top : thr_bot;
      ... // identical quant math, single x-iteration
    }
    return;
  }
  // ...original general loop kept verbatim as fallback...
```
- **rationale:** E4 — lift loop-invariant work (the mask Load + 2 Sets + IfThenElse, done 8×/block
  per channel in the dominant 8x8 case) out of the hot path; the column blend depends only on lane
  position (invariant) and the threshold pair only on yfix (2 values). Identical ops, computed once.
- **prior_art_checked:** no match — R0 `prior-art.mjs` exit 0 (X1-X9 clear, rejected-optimizations.md
  + _backup.md no overlap). No layer-invariant sub-check needed (libjxl internal SIMD kernel; not
  scheduler/pool/protocol/facade/session/decode-handler).
- **verification:** R0 ✔ · R1 build **partial** — standalone Highway microbench of the exact OLD/NEW
  kernels compiles+runs (AVX2 & SSSE3); full `enc_group.cc` TU `-fsyntax-only` clean across the
  foreach_target expansion (host `-march=native`, export/version macros shimmed) ✔; **full optimized
  cmake/emscripten build NOT run in-session** (V4 — deferred command below) · R2 n/a (no in-tree unit
  test exercises this kernel directly; standalone parity oracle used instead) · R3 parity **bit-exact
  (max_abs_diff=0, px_differ 0/524288)** on BOTH AVX2 and SSSE3 ✔ · R4 flipflop +19.0% AVX2, ≥5% ✔
  trust:high; SSSE3 fallback +0.13% (noise, unchanged) ✔
- **commit:** `a4716392`

<finding-speed id="001-E4-qbac">
n: 21
metric: total_ms
A_median_ms: 0.3700
B_median_ms: 0.2997
delta_pct: -19.0
A_iqr_ms: 0.0318
B_iqr_ms: 0.0177
trust: high
corpus: synthetic 8x8 Y blocks (8192 blk/rep, fixed InvDequantMatrix, random DCT coeffs+qac)
size: 8x8 DCT (xsize=ysize=1, the e3-dominant block)
parity: bit-exact
max_abs_diff: 0
lut_index_diff: 0
px_differ_count: 0
pipeline_share_pct: 7.0
pipeline_estimate_pct: -1.3
journal: (in-session %TEMP%/sb-encgroup/qbac_flip.cc — kernel microbench, not the live pipeline)
</finding-speed>

> **Amdahl honesty.** The +19.0% is **kernel-only** (the whole QuantizeBlockAC inner loop, measured
> in isolation). `pipeline_share_pct: 7.0` is an **ESTIMATE** (≈ VarDCT 28% × QuantizeBlockAC ~25% of
> ComputeCoefficients) — NOT measured by `pipeline_profile.rs` (no in-session full-encode profiler for
> libjxl). So e2e `pipeline_estimate_pct: -1.3` is a flagged estimate. Further, the fast path triggers
> **only when Lanes ≥ kBlockDim = AVX2 / AVX-512** (native Tauri build); the **wasm SIMD128 (N=4)
> browser tier takes the unchanged fallback → 0%**. Net: a modest **native-AVX2-only** win, consistent
> with prior libjxl micro-opt findings (enc_ans Mul→Shift, etc.).

#### 002-E1-adjqbac · perf · E1 algebraic precombination — **DEFER**
- **where:** `lib/jxl/enc_group.cc:150` (AdjustQuantBlockAC sum loop)
- **lens:** E1 · matched_lens: E1
- **disposition:** defer
- **change_class:** perf (f32-reassoc) — **but NOT tolerance-bounded**
- **what:** `block_in[pos] * (qm[pos] * qac * qm_multiplier)` evaluates as 3 muls/pixel (left-assoc,
  no fast-math). Precombining the scalar `qac*qm_multiplier` once would cut to 2 muls/pixel.
- **why deferred:** (1) The reassociation perturbs `val`, which drives **integer quant control flow**
  (`std::abs(val) < threshold`, `rintf(val)`, sum_of_error/sum_of_vals → `*quant` adjustments) — a
  1-ULP shift can flip a quant decision → **unbounded** output-byte change, not a ≤1-LUT pixel drift.
  R3 would need full-encode Butteraugli parity, not a kernel oracle. (2) `AdjustQuantBlockAC` runs
  **only at effort≥5** (e3/kFalcon skips it), so it is off the app's default hot path. → needs
  full-build + effort≥5 corpus parity before it can be gated. Not banked.

#### 003-E4-thresh · perf · E4 CSE (cold) — **DEFER (code-quality, V5 sub-noise)**
- **where:** `lib/jxl/enc_group.cc:66-73` (QuantizeBlockAC threshold pre-loop)
- **lens:** E4 · matched_lens: E4
- **disposition:** defer · **change_class:** perf
- **what:** `0.00744f * xsize * ysize` recomputed 4× in the i-loop; hoistable to one scalar.
- **why deferred:** Fires only for `c != 1 && xsize*ysize >= 4` (X/B channels of **large** transforms
  — never the 8x8 dominant case). Compiler near-certainly hoists it already. Sub-noise per V5 → it is
  code-quality, not a perf fix; not worth a separate flipflop (user scoped to one test).

#### 004-E4-clamp · perf · E4 CSE (cold, effort≥5) — **DEFER (code-quality)**
- **where:** `lib/jxl/enc_group.cc:130` (AdjustQuantBlockAC threshold loop)
- **lens:** E4 · matched_lens: E4
- **disposition:** defer · **change_class:** perf
- **what:** `Clamp1(0.003f * xsize * ysize, 0.f, 0.08f)` recomputed 4× in the i-loop; hoistable.
- **why deferred:** effort≥5 only; large-block only; compiler-hoistable; V5 sub-noise. Code-quality.

### maint

#### 005-maint-edparam · maint · dead parameter — **DEFER (note only)**
- **where:** `lib/jxl/enc_group.cc:58-62` (QuantizeBlockAC signature)
- **lens:** (none / maint) · matched_lens: none
- **disposition:** defer · **change_class:** n/a
- **what:** `const bool error_diffusion` is never referenced in the QuantizeBlockAC body.
- **why deferred:** Removing it edits 2 call sites (`QuantizeRoundtripYBlockAC:363`,
  `ComputeCoefficients:504`) — out of a single-file perf scope, zero perf impact, and the dead arg may
  be an intentional signature-parity placeholder vs `AdjustQuantBlockAC`. Note for a maint pass.

### correctness (F pass)
No findings. Bounds/overflow audited: every `*quant` mutation clamps to `Quantizer::kQuantMax`;
`mul[c]`/`val[c]` arrays are size-3 with `c ∈ {0,1,2}`; `kPartialBlockKinds` bitmask is in range;
`kMask`/quadrant indexing within `[0,4)`; no OOB, no signed-overflow, no UB observed. Clean.

**Section summary:** 1 byte-exact native-AVX2 kernel win landed (QuantizeBlockAC threshold hoist,
+19% kernel / ~1.3% e2e est); 3 perf micro-opts deferred (1 not-byte-exact + effort≥5, 2 cold/
compiler-hoistable code-quality); 1 maint note; F pass clean.
**Section conclusion:** Mature, already-tight libjxl SIMD code. The only defensible measured win on
the e3 hot path was the threshold hoist; the rest are either off-path (effort≥5), cold (large-block),
or below the V5 noise floor. No correctness issues.

---

## Seam analysis
1-hop neighbors of `enc_group.cc` (C6 zero-copy + B1 stride only): the per-block DCT
`TransformFromPixels` / `DCFromLowestFrequencies` (`enc_transforms-inl.h` / `dec_transforms-inl.h`)
are the **larger** cost center inside `ComputeCoefficients` but are out of this file. The
`coeffs_in`/`quantized` scratch buffers are passed by raw pointer (already zero-copy). No seam ABI/
stride finding.

## Follow-up targets
- `external/libjxl-012/lib/jxl/enc_transforms-inl.h` — DCT forward transform; dominates
  ComputeCoefficients wall-time, the real lever for VarDCT speed (recommended NEXT target, not edited).

## Unifying sweep
Single-file run — no cross-file (≥2-file) opportunity. No duplicate file:line across lenses.

---
## Run conclusion
- **Swept:** 1 file · 534 LOC · Category C+D+E+F · mode=inline (user-scoped: 1 flipflop, 1 run)
- **Findings:** 5 (perf 4 · maint 1)
- **Disposition:** direct_fix 1 · adr_draft 0 · defer 4 · dropped_X 0
- **Realized pipeline estimate:** **−1.3% e2e (ESTIMATE, native-AVX2 only; 0% on wasm SIMD128)** —
  kernel-measured −19.0% byte-exact, Amdahl-attributed with an *estimated* (not profiled) stage share.
- **Top win:** 001-E4-qbac (kernel −19.0% AVX2, e2e ~−1.3pp est, bit-exact, commit a4716392)
- **Termination state:** code-saturated for the user-scoped single-pass review; 4 defers recorded.
- **Build status:** R1 partial — microbench + foreach_target `-fsyntax-only` clean; **full optimized
  build deferred**, run from `external/libjxl-012`:
  `cmake --build build --target jxl_enc-obj` (or the project's
  `node packages/jxl-wasm/scripts/build.mjs --host-toolchain` for the wasm tier) then re-encode a
  corpus and confirm byte-identical output vs pre-edit.
- **Run-Stop:** 2026-06-24T07:10Z · **Duration:** 13m
- **Worktree teardown (after merge/inspection):**
  `cd C:/Foo/raw-converter-wasm/external/libjxl-012; git worktree remove C:/Foo/rcw-sb-encgroup`
  (branch `scannerbot/24-06-26-encgroup` holds commit a4716392 — cherry-pick/merge into
  `perf/acs-entropy-cleanups` when the full build confirms).
