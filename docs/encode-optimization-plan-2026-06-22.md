# Encode optimization — plan & ledger (2026-06-22)

Owner: this session is leading. Goal: cut JXL **encode** time (the post-MT cost center).

## Why encode

Native per-file (rayon 12 + libjxl 12), avg DNG: encode **~390ms = 74%** of total; decode+demosaic+tone = 21% (already MT'd, won). Encode is the front now.

## Decisive profiling result

`benchmark/enc-subtimer-probe.mjs` (1920×1440 RGBA, effort 3, dist 1.0, hasAlpha:false):

```
enc_wasm_encode  454.00 ms  99.6%   ← libjxl VarDCT core
enc_heap_set       1.41 ms   0.3%
marshal (all)      ~0.4%
```

→ **99.6% of encode is inside libjxl.** casabio_encode.rs marshaling = 0.4% (dead lever — the past LE-pack/strip/alpha wins were on RAW→RGB, not encode). To move encode, must touch the libjxl core or its build.

## Levers, ranked

| # | lever | risk | ROI | status |
|---|---|---|---|---|
| 1 | **PGO on libjxl enc** (build-time) | none (no algo change, byte-parity) | ~5-15% | **driving** |
| 2 | hand-optimize hottest `enc_*.cc` | high (fork maintenance) | unknown — needs profile | gated on #3 |
| 3 | stage-profile libjxl encode | — | — | needed before #2 |

casabio_encode.rs / bridge.cpp marshaling: **0.4%, skip.**

## PGO (lever 1) — scoped, NOT Docker-blocked

Runs on host emcc (`C:\Users\User\emsdk`, emcc 4.0.14) + `llvm-profdata` (LLVM/bin). Corpus manifest + `.ppm` fixtures present. `build-pgo.mjs` has Windows submodule fallbacks. Configure-probe (`--configure-only`) validated host build works.

Pipeline (`packages/jxl-wasm/scripts/build-pgo.mjs`): train (`-fprofile-generate` → run corpus → `llvm-profdata merge` → `dist/jxl.profdata`) → apply (`-fprofile-use` → `dist/jxl-core.enc.simd.js`).

**The one real gap:** emits the **`enc.simd` (non-MT)** tier; the app runs **`relaxed-simd-mt`**. So:
- **Phase 1:** run full PGO on simd tier, measure PGO vs non-PGO (byte-parity) — proves the machinery + the win on the core.
- **Phase 2:** extend `buildEncSimd` → `buildEncSimdMt` (pthread flags: `-pthread -sUSE_PTHREADS=1 -sSHARED_MEMORY=1 -matomics -mbulk-memory`), emit `jxl-core.enc.simd-mt.*`, wire the tier loader, verify with `tools/encode-mt-bench.mjs`.

## libjxl hot files (for lever 2/3, effort-3 lossy VarDCT)

`enc_adaptive_quantization.cc` (AQ, per-block, prime suspect) · `enc_frame.cc` · `enc_ans.cc` (ANS) · `enc_xyb.cc` (color) · `enc_group.cc` (DCT+quant) · `enc_ac_strategy.cc`. SKIP `enc_fast_lossless.cc` (lossless path) + `enc_modular.cc` (modular mode) — not used in lossy config.

## PGO repoint to libjxl-012 — DONE (2026-06-22)

`build-pgo.mjs` now sources the in-repo `external/libjxl-012` (env `JXL_PGO_LIBJXL_SRC` to override),
not a fresh v0.11.2 clone — unifies wasm PGO with the native jxl-ffi source + kills the version skew.
Edits: `sourceDir` → localLibjxl; `ensureLibjxlSource` verify-not-clone; `ensureLibjxlDeps` verify-not-
populate (never mutate the submodule). Confirmed: 012 compiles clean under emscripten 4.0.14 (201/201
archives). NOTE: the normal wasm dist build (`build.mjs`) STILL clones 0.11.2 — repoint it too if the
shipped web/pkg libjxl should match native 012.

## PGO link bug — ROOT-CAUSED, still blocking (deep emscripten internal)

`-fprofile-generate` at the bridge **link** → LLVM emits `__profd_*`/`__profc_*` profile-counter globals
(e.g. `jxl::Plane<float>::Create`, linkonce_odr, `.`-suffixed) marked `llvm.used`. emscripten keeps them
alive by adding them to `settings.EXPORTED_FUNCTIONS`, then `emscripten.py:357 isidentifier()` rejects the
`.`-containing name → `em++: invalid export name`. Tried + FAILED: `-fvisibility=hidden`
`-fvisibility-inlines-hidden` (doesn't suppress `llvm.used` linkonce profile globals). Dead end: cannot
instrument-at-compile-only + link runtime manually — emscripten's wasm `libclang_rt.profile.a` is NOT in
the cache (only materialized via `-fprofile-generate` at link). Remaining candidates (each ~10min/build,
uncertain): (a) suppress profd from the wasm-ld export set / post-strip with Binaryen; (b) `-fprofile-
instr-generate` (frontend instrumentation, different symbol handling) + `-fprofile-instr-use` on apply;
(c) bump emscripten (may be fixed upstream). Bounded ~5-15%, wasm-only, encode already <1s → low ROI.

## PGO — UNBLOCKED + MEASURED (2026-06-22)

Link bug FIXED via frontend instrumentation (`-fprofile-instr-generate`/`-fprofile-instr-use`) — IR-PGO
marked COMDAT counters wasm-EXPORTED. Full pipeline works against libjxl-012: `--train` → `--apply`,
plus `--plain` baseline. Measured `enc.simd` e3 10MP, interleaved 5×21 reps, min: PGO ~3-4% faster,
byte-identical (591KB). Modest (SIMD hot path + narrow 1-image corpus + non-MT tier). Full recipe:
memory `project-wasm-pgo-libjxl012-fixed`. Next to lift the %: richer corpus (reuses instrumented module,
1 apply rebuild) and/or Phase-2 simd-mt tier (the tier the app runs).

## PGO (lever 1) — was PARKED at toolchain bug (now fixed, see above)

Full simd train+apply ran; libjxl static libs built clean, but the instrumented **bridge link fails**:
`em++: error: invalid export name: "___profd__ZN3jxl5PlaneIfE6Create...146835647075900052"` — the
`-fprofile-generate` LLVM profile-counter symbols leak into the wasm export set with a `.`-suffixed
name emscripten rejects (both `-flto` and no-`-flto`). Real emscripten 4.0.14 + PGO bug. Candidate
fixes (later): don't instrument bridge.cpp; `-fprofile-instr-generate` instead of IR-level; strip
`__profd_*` from the export allowlist. Bounded ~5-15%, wasm-only → deprioritized vs profiling.

## Stage timers — PERMANENT diagnostic (kept by user request)

`enc_frame.cc` has `JXL_STAGE_TIMERS` env-gated timers (zero-cost when unset) around the VarDCT
phases. Run any jxl-codec native encode with `JXL_STAGE_TIMERS=1` to print per-stage ms to stderr.
Coverage: `ComputeVarDCTEncodingData` (XYB+AQ+ACS+CfL+DCT), `TokenizeAllCoefficients` (entropy-prep).
TODO: add `BuildAndEncodeHistograms` (ANS) timer for full coverage once round-1 split is read.

## RESULT — encode stage split (real 20.5MP ORF, effort 3 d=1.0, native, JXL_STAGE_TIMERS)

Sum over 6 DC groups (streaming mode), % of ~729ms encode wall:

| stage | % | code |
|---|---|---|
| EncodeGroups (histogram-build + AC rANS) | 33% | enc_ans.cc / enc_cluster.cc / enc_group.cc |
| ComputeVarDCTEncodingData (XYB+AQ+ACS+CfL+DCT) | 28% | enc_xyb / enc_adaptive_quantization / enc_ac_strategy |
| other-CED (modular tree/tokens, coeff-orders, setup) | 26% | enc_modular.cc / enc_coeff_order |
| TokenizeAllCoefficients | 5% | enc_group.cc |
| output/container | 8% | — |

**Encode is DISTRIBUTED in ~equal thirds — no single fat stage.** (Round-2 "59% entropy" was an
over-count; the tail also held the 26% modular/setup. EncodeGroups pinned at 33%.)

## VERDICT: do NOT fork libjxl

Biggest stage 33%, upstream Highway-SIMD rANS → realistic hand-opt ~1.1-1.3×, Amdahl-capped to a
third of encode. Distributed work → the correct lever is **PGO** (global, all branchy stages, no
fork), not single-stage hand-optimization. "Profile first" decided against the fork.

## Permanent diagnostic (kept)

`enc_frame.cc` `JXL_STAGE_TIMERS` env-gate (zero-cost off) prints: ComputeVarDCTEncodingData,
TokenizeAllCoefficients, EncodeGroups, ComputeEncodingData TOTAL. Run any jxl-codec native encode
with `JXL_STAGE_TIMERS=1`. Reusable for measuring any future encode change.

## Next actions
1. DECISION (user): fix PGO bridge-link bug (best-justified lever, bounded ~10%, wasm-only) OR
   accept encode done (<1s, effort-3, MT, /O2, no concentrated target).
2. If PGO: don't instrument bridge.cpp (only libjxl); or `-fprofile-instr-generate`; or strip
   `__profd_*` from export allowlist. Then build simd-mt PGO tier + wire + encode-mt-bench.
3. Native encode already 12-thread MT; per-file <1s. Batch already file-parallel (12×1 optimum).
