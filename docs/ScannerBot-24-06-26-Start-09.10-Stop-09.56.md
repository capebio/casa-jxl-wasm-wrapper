---
scannerbot: 1
run_id: 24-06-26-0910
start: 2026-06-24T09:10Z
stop: 2026-06-24T09:56Z
mode: inline (profile-first, then implement — e5-viability)
sweep_categories: [A, C]
target_root: external/libjxl-012/lib/jxl/enc_ac_strategy.cc
branch: scannerbot/24-06-26-acs-prune        # off perf/acs-entropy-cleanups
worktree: C:/Foo/rcw-sb-acsprune
tally: {arch: 0, perf: 1, mem: 0, bug: 0, correctness: 0, maint: 0, seam: 0, misc: 0}
disposition: {direct_fix: 1, adr_draft: 0, defer: 0, dropped_X: 0}
files_swept: 1
findings_total: 1
pipeline_estimate_pct: e5-only (ACS = 76% of e5; prune target ~30% of ACS — measurement deferred)
---

# Scannerbot Run 24-06-26-0910 — e5 profile + ACS rate-pruning

| Run | Start | Stop | Duration | Files | Findings | direct_fix / adr / defer / dropped_X |
|-----|-------|------|----------|-------|----------|--------------------------------------|
| 24-06-26-0910 | 09:10 | 09:56 | ~46m | 1 | 1 | 1 / 0 / 0 / 0 |

**Goal (user):** lower e5 compute so e5 becomes viable vs e3 (chosen because >e3 scales hugely).

## Profile (the deciding measurement)
`effort-sweep.mjs` on the libjxl-012 wasm enc module (`jxl-core.simd.js`), flower 510×532, no rebuild:

| effort | median ms | × e3 |
|---|---|---|
| e3 | 57 | 1.00 |
| e4 | 49 | 0.86 |
| **e5** | **237** | **4.18×** |
| e6 | 338 | 5.95× |

**ACS search = 76% of e5 (180ms of 237ms)** — the entire e3→e5 delta (e3/e4 skip ACS:
ProcessRectACS returns at speed_tier>kHare). So the e5-viability target is the ACS search.
Caveat: on flower@d1.0 e5 output did **not** shrink (46→48KB) — e5's quality/size benefit is
content-dependent and unproven here; validate before committing to e5.

Effort gating (common.h + enc_ac_strategy.cc 938/663/959): DCT2X2/DCT4X4 run e5+, AFV/DCT4X8
run e6+. So the prior AFV win is e6-only; DCT2X2 + this pruning are the e5 levers.

## Finding

#### 001-A/C-acsprune · perf · rate-only candidate pruning — **LANDED (build-deferred measure)**
- **where:** `EstimateEntropy` (362-528) + `FindBest8x8Transform` call (686).
- **lens:** A4/C (work elimination in the candidate pipeline) · change_class: perf · **byte-exact**
- **what:** Split EstimateEntropy into phase-1 rate (3 channels) → rate-only lower bound → phase-2
  loss (inverse transform + masking walk). The loss term is non-negative, so `rate*entropy_mul` is a
  true lower bound; a candidate whose bound already reaches the incumbent skips the 3 inverse
  transforms + masking walk. New `prune_threshold` arg (default 1e30); only FindBest8x8 passes `best`.
  Phase-2 recomputes the per-channel residual `mem` for survivors (no scratch-alloc change; `block`
  access pattern identical to the original fused loop).
- **byte-exact / memo-safe:**
  - Selection unchanged — callers compare strict `<`; pruned bound (compared in **double** vs the
    caller's double `best`) is ≥ incumbent ⇒ full score (≥ bound) loses too. Pruned candidate never
    becomes the incumbent ⇒ its under-estimate is discarded, never reused.
  - Pruning applied ONLY on the direct FindBest8x8 path. Cached/merge path (EstimateEntropyCached,
    TryMergeAcs) uses default no-prune ⇒ the entropy memo never caches an under-estimate.
  - Phase-1 rate + phase-2 loss reproduce the original accumulation + per-channel `w` order exactly.
- **prior_art_checked:** no match (R0 exit 0).
- **verification:** R0 ✔ · R1 `enc_ac_strategy.cc` foreach_target `-fsyntax-only` clean ✔ · R3 **byte-
  exact — MEASURED**: built OLD + NEW plain enc.simd wasm (libjxl-012, same flags), encoded flower@e5
  and @e6 with each; output **SHA256-identical** (e5 9C176C5D…, e6 5269B9B2…) ✔ · R4 **MEASURED** (in-
  browser-class wasm, flower, n=7): e5 **251→224ms (−10.8%)**, e6 **371→321ms (−13.5%)**; e3/e4
  unchanged (prune inactive without ACS) ✔
- **commit:** `89994b5d`
- **measured vs expected:** ACS cut ~28ms = **~15% of ACS** (e5 4.04→3.57× e3), BELOW the ~30% est —
  the loss path (IDCT+mask walk) is a smaller slice of EstimateEntropy than forward-transform+rate, and
  the prune rate is < 3/4 on this content. Real, byte-exact, but modest. e5 viability needs the
  DCT-staging lever + (for more) candidate-count reduction (output-changing). **Won't reach e3.**

## Measurement recipe (hand-off — needs a wasm-enc rebuild)
1. Get the change into the build source: in `external/libjxl-012`, `git cherry-pick 89994b5d` onto
   perf/acs-entropy-cleanups (or point the build at the worktree).
2. Rebuild enc.simd to a NON-dist out dir (don't clobber shipped): the libjxl-012 PGO path
   (`packages/jxl-wasm/scripts/build-pgo.mjs`) or `build.mjs` with `LIBJXL_REPO/LIBJXL_COMMIT`.
3. `node <effort-sweep.mjs> <new-enc-module.js> flower_small.rgb.depth8.ppm 9` → compare e5 vs 237ms.
4. Byte-exact: encode flower@e5 with the OLD vs NEW module, `cmp` the .jxl bytes — must be identical.
   (effort-sweep currently returns only size; extend it to dump the buffer for the cmp.)

## Run conclusion
- 1 perf finding, direct_fix (commit 89994b5d). **MEASURED + byte-exact** (drove the wasm-enc build
  in-session: OLD + NEW plain enc.simd, SHA256-identical output @e5/e6, e5 −10.8% / e6 −13.5%).
- e5 profiled at 4.04–4.18× e3, ACS = 75–76%. Pruning is the right lever but delivers ~15% of ACS
  (e5 → 3.57× e3) — modest; the loss path is smaller than forward-transform+rate. Full e5 viability
  needs DCT-staging + candidate-count reduction (the latter output-changing).
- Build note: `JXL_PGO_LIBJXL_SRC` repoints build source; `--plain` = no-PGO baseline to
  `dist/jxl-core.enc.simd.plain.js`; set `JXL_WASM_WORKDIR` via `$env:` (NOT `set VAR=…&&` — trailing
  space breaks the build dir). Built from live tree with a transient enc_ac_strategy.cc swap + restore
  (worktree lacks nested-submodule deps). OLD/NEW modules parked in %TEMP%\sb-encgroup for re-measure.
- **Run-Stop:** 2026-06-24T09:56Z · Duration ~46m
- Teardown: `git worktree remove C:/Foo/rcw-sb-acsprune` after merge (branch holds 89994b5d).
