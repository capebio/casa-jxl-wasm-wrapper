# conv5 edge-coverage — verification results (2026-06-29)

Branch `perf/enc-conv5-edge-coverage-z3k` (super + submodule). Harness
`tools/conv5_ab.cc` (links worktree `jxl-internal.lib`), cross-target via
`SetSupportedTargetsForTest` (AVX2 N=8; SSE4/SSSE3/SSE2/EMU128 N=4; SCALAR N=1).

## Correctness

- **FNV byte-exact OLD==NEW**: 72 configs (12 geometries × 6 targets), all
  identical after every byte-exact change (scalar-tail elision, status,
  border-dedup, tiny-height). Confirms zero output change on the wide path.
- **slow (Separable5 vs SlowSeparable5 ≤1e-5)**: 0 failures across 6 targets ×
  30 configs, including the width-cliff widths exercised by RunNarrow:
  - N=8 (AVX2): 8×32 maxrel 2.2e-7, 9×32 maxrel 3.1e-7.
  - N=4 (SSE4/SSSE3/SSE2/EMU128): 4×32 maxrel 3.2e-7, 5×32 maxrel 3.3e-7.
  (convolve_test gtest was unavailable — its cmake test build hard-requires
  system PNG; this harness's slow sweep replaces it with equivalent
  Separable5-vs-SlowSeparable5 coverage.)

## Timing (full-image hot path = real caller shape)

1024×1024, `pool=nullptr` (butteraugli serial shape), 200 iters/run.
Interleaved OLD/NEW ×12 to cancel thermal drift:

- **NEW/OLD median ≈ 96.6%** → NEW neutral-to-slightly-faster; **non-regression**.
- (A naive sequential measure showed ~10% but that was thermal-order bias; the
  interleaved ratio is the trustworthy number.)

Expected: the changes are off the hot interior (the already-landed y-ring);
border-dedup touches 4 rows/rect, scalar-tail elision is a no-op for 1024 wide
(1024%8==0), tiny-height/width-cliff never fire for full images.

## Decision (rules 9/10)

Keep all five — byte-exact/within-tolerance AND non-regressing on the hot path.
Nothing dropped → no entry in `docs/1 rejected optimizations.md`.
