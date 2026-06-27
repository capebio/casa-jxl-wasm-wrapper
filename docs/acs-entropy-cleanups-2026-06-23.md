# AC-strategy entropy-kernel cleanups — implementation & measurement (2026-06-23)

Branch (submodule `external/libjxl-012`): **`perf/acs-entropy-cleanups`** @ `8d1769f2`
Target: `lib/jxl/enc_ac_strategy.cc` + `.h` — the `EstimateEntropy` + merge selection
kernel. Premium high-effort **lossy** path only (`speed_tier <= kHare`, i.e. effort ≥ 5;
true lossless = modular mode, no `ProcessRectACS`).

Gate (per user): **2%** speedup. Gating efforts: **7 (kSquirrel)** and **9 (kTortoise)**.
Harness: `crates/raw-pipeline/examples/acs_effort_bench.rs` (+ `run-acs-ab.ps1`),
native MSVC/ClangCL, interleaved A/B with byte-compare. Wasm enc.simd confirmation.

## Headline

| Change | Decision ordering | Effect | Verdict |
|---|---|---|---|
| #1 dead `quantized`/`qmem` removal | byte-exact | drops unused per-thread arena | **adopt** |
| #2 mask1x1-absent bypass | byte-exact | ~0% (mask1x1 always present in normal encode) | adopt (safety) |
| #2b c==1 Y-load skip | byte-exact | hot-loop work −⅓ on 1 of 3 channels | **adopt** |
| #3 fast-tier alloc/Init skip | byte-exact | only tiers > kHare (not benchmarked) | adopt (cleanup) |
| #4 `EstimateEntropy` → void | byte-exact | drops dead status branches | **adopt** |
| #4b mask1x1 robustness | byte-exact | closes uninit-row hazard | adopt (safety) |
| #5 single-pass `Finalize` histogram | byte-exact | replaces 21 scans (aux_out path only) | adopt |
| **#6 per-rect entropy memo** | **byte-exact** | **−3.43% of all entropy evals (deterministic)** | **adopt** |
| #6b `pow(x,⅛)`→`sqrt³` | NOT decision-safe | 0.18% (no benefit) | **reject** |

**Bundle (SAFE + #6 memo) is byte-identical `.jxl`** at effort 7 and 9, across two
images (ADH_1248, P1110226) and two crop sizes (1920×1280, 1024×768). Verified by
SHA-256 of encoder output — i.e. every block's strategy and every coefficient
unchanged. Decision ordering is preserved exactly.

## The real lever: entropy memo (#6), measured deterministically

The dev box was saturated by concurrent processes; end-to-end wall time could not be
resolved to 2% (the same baseline binary varied 57% between runs). So the memo was
quantified with a **contention-immune op-count** (env `JXL_ACS_STATS`, temporary
scaffolding, not committed):

```
ACS_STATS computed=463418 memo_hits=16437 total_evals=479855 memo_saved=3.43%
```

- The memo serves **3.43% of all `EstimateEntropy` evaluations from cache** — the
  floating/non-aligned merge passes re-evaluate the same rectangular candidate from
  adjacent squares; the cache returns the previously-computed float (3 transforms +
  masking avoided). Keyed by `(kind, local x, local y)` with an `entropy_mul`
  key-guard, so it is bit-exact even if the kind→mul mapping ever stops being 1:1.
- Counts are **identical at effort 7 and 9** → the ACS kernel does the *same work* at
  both tiers. e9's large extra wall time is the `FindBestQuantizationHQ` butteraugli
  loop, **not** the kernel — so a kernel change is ~3.4% of the kernel but a tiny
  fraction of e9 end-to-end.

The cleanest single-thread wall reads agreed: **e7 ≈ 3.5%** (e.g. ADH 1024×768:
baseline 295.3 ms → variant 284.8 ms, 3.56%, byte-exact), consistent with memo 3.43%
+ the c==1 Y-skip. Noisy/negative round numbers were pure contention artifacts (min of
round-mins picking the least-preempted run asymmetrically).

## Why #2 and #3 don't move the gating number (but are kept)

- `mask1x1` is always produced by `ComputeMask` in normal encode, so the #2 bypass
  rarely fires. It is byte-exact and a genuine win only in configs where the 1×1
  masking field is disabled.
- Fast tiers (> kHare) already short-circuit `ProcessRectACS`; we never benchmark
  them. #3 just stops allocating scratch they don't use.

Both are correct, byte-exact cleanups — adopted, but not the lever.

## Rejected: #6b eighth-root via sqrt³

`pow(mean_loss, 1/8)` runs once per `EstimateEntropy` but is dwarfed by the SIMD
transform + masking work. Replacing it measured **0.18%** (noise) and is *not*
decision-preserving in general (it only happened to be byte-exact on the test image).
Left in source behind `ACS_EXP_SQRT8` (default off). Consistent with the repo thesis:
wins are in the SIMD seams, not scalar functions.

## Also flagged (no patch)

- **butteraugli_target == 4 cliff** (`FindBest8x8Transform`): the
  `kAvoidEntropyOfTransforms` penalty jumps from 0 at exactly 4.0 to ~4000 at 4.001.
  Likely intentional but worth a 3.9–4.2 sweep before touching.

## Reproduce

```powershell
# native A/B (single-thread = low-noise under contention)
$env:JXL_BENCH_THREADS=1
crates/raw-pipeline/examples/run-acs-ab.ps1 -Baseline acs_bench_baseline.exe `
  -Variant acs_bench_variant.exe -Ppm <full.ppm> -Efforts 7 -Rounds 8 -Reps 4
# deterministic memo rate: rebuild with the JXL_ACS_STATS scaffolding, then
$env:JXL_ACS_STATS=1; acs_effort_bench.exe <ppm> 7 1 out.jxl 1920 1280 0
```
