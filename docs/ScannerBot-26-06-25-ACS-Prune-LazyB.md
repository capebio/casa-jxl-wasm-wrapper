# ScannerBot — 2026-06-25 — ACS Prune: Lazy-B + Per-Channel + Intra-Channel

## Summary

Implemented three admissible pruning optimizations in `EstimateEntropy`
(enc_ac_strategy.cc). All fire only when a candidate cannot beat the current
incumbent (`best`). All remaining channel contributions and info_loss are
non-negative → lower-bound checks are safe.

## Changes

**Submodule commit:** `6ffc7616` on branch `scannerbot/26-06-25-acs-prune`
**Superproject:** EpicPipeline (captures `66e44028` which includes this + David's enc_group opts)

### 1. Lazy-B

Transform Y (c=1) and X (c=0) upfront; defer Blue (c=2) `TransformFromPixels`
until both X and Y survive per-channel rate pruning. Saves one `TransformFromPixels`
call per pruned candidate.

### 2. Per-Channel Rate Prune

After completing each of c=0 and c=1 (full loop + zeros_mul + w_large), check:
```
entropy_partial * entropy_mul >= prune_threshold (= best)
```
If true, return early. Remaining channels + info_loss are non-negative → admissible.
Return value = rate_c ≥ prune_threshold → caller discards it.

### 3. Intra-Channel Block-Boundary Prune

Inside the inner coeff loop, at every 64-coeff (8×8) block boundary for
multi-block candidates, check a lower bound on the partial rate:
```
lb = cost_delta * partial_entropy_v_sum * w_large   (c=0)
lb = entropy_accumulated + cost_delta * partial_sum  (c>0)
lb_rate = lb * entropy_mul >= prune_threshold
```
Fires only when `num_blocks > 1` and `next_i < coeff_total` (not at last boundary).

### FindBest8x8Transform

Now passes `best` as `prune_threshold` to `EstimateEntropy`, so each evaluated
candidate sets the bar for all subsequent evaluations.

## Measurement

### Native (MSVC, AVX2, ecr-test.ppm 24MP, 6 rounds × 4 reps)

| Effort | Baseline min | Variant min | Speedup | Byte-exact |
|--------|-------------|-------------|---------|------------|
| e7     | 726.68 ms   | 740.02 ms   | −1.84%  neutral | ✓ (248297 B) |
| e9     | 11706 ms    | 11015 ms    | **+5.91% PASS** | ✓ (233736 B) |

Baseline: `acs_base2.exe` (original EstimateEntropy + 0add5164 DCT-fuse, no prune).

e7 neutral: effort 7 uses fewer large-transform evaluations than e9 → less ACS candidate work to prune.
e9 pass: high effort evaluates more candidates per block → pruning eliminates more work.

### WASM (enc.simd.plain, single-thread, same 24MP image)

No A/B: old baseline WASM build failed (dec_group_border.cc changes in David's
WIP dec_group branch conflict with Emscripten; unrelated to ACS prune). New module
absolute times only:

| Effort | min      | med      |
|--------|----------|----------|
| e5     | 14782 ms | 18564 ms |
| e7     | 29115 ms | 39859 ms |

Prior ACS prune session (89994b5d, different implementation) measured e5 −10.8% /
e6 −13.5% in WASM single-thread. My implementation (fused loop, lazy-B, per-channel,
intra-channel) expected similar order of magnitude.

## Baseline Notes

- `acs_base.exe`: built from 8d1769f2 (pre-DCT-fuse). **Stale** — produces 240654 B vs 248297 B from current DCT. Do not use.
- `acs_base2.exe`: built from 0add5164 (exact original EstimateEntropy + DCT-fuse). **Correct baseline** for comparisons within current submodule state. Produces 248297 B at e7.
- `0add5164` ("fuse forward-DCT scale into transpose") changes coefficient values on AVX2 → non-byte-exact vs 8d1769f2 era. This is expected and correct.

## Key Invariants

- Fused loop preserved (`Store(Mul(m,diff), df, &mem[i])` stays in same inner loop as `entropy_v` accumulation). Required for byte-exact vs original — splitting changes compiler vectorization of `entropy_v` sum.
- Default `prune_threshold = 1e30` in EstimateEntropy signature → `EstimateEntropyCached` callers unaffected (they don't pass `best`).
