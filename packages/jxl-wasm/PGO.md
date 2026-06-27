# PGO — profile-guided optimization of the encode tier

The shipped `dist/jxl-core.enc.relaxed-simd-mt.{js,wasm}` is **PGO-optimized**
against `external/libjxl-012` using `dist/jxl.profdata` (committed). Output is
**byte-identical** to the non-PGO build — PGO only changes code layout/speed.

## Measured

- **enc.simd** (single-thread, clean signal): **~3-4% faster**, byte-identical
  (`tools/wasm-enc-bench.mjs`, interleaved 5×21, min).
- **relaxed-simd-mt** (production tier): same compiled libjxl-012 → the ~3% is
  present on compute, but **unmeasurable in browser** — MT wall-time noise floor
  is ±8-11% (threading + memory-growth + scheduling), 3× the signal
  (`tools/encode-mt-browser-bench.mjs`, Chromium + COOP/COEP). Shipped on the
  strength of the enc.simd proof + identical-code inference. Scales up on weak
  CPUs (mobile) where branch-layout/i-cache wins matter more.

## How the pipeline works

Frontend-instrumentation PGO over libjxl-012 (NOT IR-`-fprofile-generate`, which
marks COMDAT counters wasm-EXPORTED → `em++: invalid export name`). Tooling:
`packages/jxl-wasm/scripts/build-pgo.mjs`.

Regenerate (needs host emsdk + emsdk `llvm-profdata`):

```
# 1. train: build instrumented MT module, run corpus, merge profile
node packages/jxl-wasm/scripts/build-pgo.mjs --train --mt
#    → writes dist/jxl.profdata

# 2. apply: build the shipped browser PGO module (-fprofile-instr-use)
node packages/jxl-wasm/scripts/build-pgo.mjs --apply --mt --browser
#    → writes dist/jxl-core.enc.relaxed-simd-mt.{js,wasm}
```

Corpus: `packages/jxl-test-corpus/pgo-manifest.json` + `.ppm` fixtures
(`generate-pgo-fixtures.mjs <raw...>`, uncapped via `PGO_SOURCE_LIMIT`).
Merge MUST use the **emsdk** `llvm-profdata` (profile-format-version match).
`--plain --mt --browser` builds a non-PGO baseline for A/B.

## ⚠ Caveats

- **`scripts/build.mjs` reverts this.** The normal dist build clones libjxl
  **0.11.2** (not 012) and produces a non-PGO enc module. After any `build.mjs`
  run, re-apply: `build-pgo.mjs --apply --mt --browser`. (Proper durable fix:
  repoint `build.mjs` to libjxl-012 + inject `-fprofile-instr-use` into the enc
  tiers — separate task; tracked as the version-skew item.)
- Re-train only when libjxl-012 source changes materially (pinned submodule).
- `facade.ts` loads `jxl-core.enc.${tier}.js` by name — no wiring needed; the
  PGO artifact at that filename is the shipped module.
- Fallback tiers (`simd`, `simd-mt`) are NOT PGO'd yet (only relaxed-simd-mt).
