---
scannerbot: 1
run_id: 24-06-26-1410
start: 2026-06-24T14:10Z
stop: 2026-06-24T14:37Z
mode: inline (probe-then-build)
sweep_categories: [C, D]
target_root: external/libjxl-012/lib/jxl/dct-inl.h
branch: scannerbot/24-06-26-dct-transpose-fuse   # on top of fe2a017b
worktree: C:/Foo/rcw-sb-dctfuse
tally: {arch: 0, perf: 1, mem: 0, bug: 0, correctness: 0, maint: 0, seam: 0, misc: 0}
disposition: {direct_fix: 1, adr_draft: 0, defer: 0, dropped_X: 0}
files_swept: 1
findings_total: 1
pipeline_estimate_pct: native-only (AVX2 +24.7% on DCT8x8 kernel; wasm 4-lane falls back = 0)
---

# Scannerbot Run 24-06-26-1410 — DCT8x8 transpose-fusion

> **Base moved:** worktree cut from **fe2a017b** (David, 14:16) which independently landed fused
> DCT2X2 + AFV ix-fix (superseding my dct2x2 `a61e500d` + afv `999c6f17` branches — dropped) + a new
> DCT8X4/DCT4X8 **direct-sink** (FinalTo/CoeffRowSinkTo, removes the OUTPUT scatter). This run's
> transpose-fusion is **complementary** (removes the INTER-PASS `to` round-trip, distinct round-trip).

## Probe (decided the build)
`ComputeScaledDCT<8,8>` = ~43 ns/block; **Transpose<8,8>::Run alone = 36% of it** (15.3 ns) — a real,
non-elidable memory round-trip (the wrapper packing is "ideally optimized away" per author comments;
the transpose is not). Fusion ceiling ~18–25%.

## Finding

#### 001-C6-dctfuse · perf · C6 zero-copy / D-kernel — **LANDED**
- **where:** `dct-inl.h` `ComputeScaledDCT` (ROWS≥COLS) + new `ScaledDCTFrom` adaptor.
- **change_class:** perf · **byte-exact** (data-movement reorg; FMA arithmetic untouched)
- **what:** Original ROWS≥COLS: `DCT1D(from→to)` (StoreToBlockAndScale writes 1/ROWS-scaled to `to`)
  then `Transpose(to→block)` (re-reads `to`). Fuse: when one vector spans the COLS row
  (`Lanes(HWY_FULL) ≥ COLS`), run `LoadFromBlock + DCT1DImpl` into `tmp`, then `Transpose(ScaledDCTFrom(
  tmp, 1/ROWS) → block)` — the 1/ROWS scale folded into the transpose's load, skipping the `to` write
  + re-read (~16 float mem ops/block). Falls back to the original staged path for narrow lanes.
- **byte-exact proof:** same `Mul(1/ROWS, x)` per element, same transpose permutation (scale commutes
  with permutation). MEASURED parity **0 / 1048576, max_abs_diff 0** over random + impulse/const/ramp,
  on AVX2 (fused) AND SSSE3 (fallback).
- **prior_art_checked:** no match (R0 exit 0).
- **verification:** R0 ✔ · R1 `enc_transforms.cc` foreach_target `-fsyntax-only` clean + bench
  compiles/runs both targets ✔ · R3 byte-exact (measured, above) ✔ · R4 flipflop (16384 blk, n=21):
  **AVX2 +24.7%** on ComputeScaledDCT<8,8>; SSSE3 −0.3% (fallback, unchanged) ✔ trust:high
- **commit:** `ab8418d7`

<finding-speed id="001-C6-dctfuse">
n: 21
metric: total_ms
A_median_ms: 1.3950
B_median_ms: 1.0506
delta_pct: -24.69
A_iqr_ms: 0.1591
B_iqr_ms: 0.1949
trust: high
corpus: synthetic 8x8 blocks (16384/rep), ComputeScaledDCT<8,8> forward DCT
size: DCT8x8
parity: bit-exact
max_abs_diff: 0
px_differ_count: 0
note: A/B interleave doubles working set -> OLD shows 85 ns/blk vs 43 single-arm baseline; ratio holds. NATIVE AVX2/AVX-512 ONLY (wasm SIMD128 4-lane -> fallback, 0). Real-world in-situ likely ~15-25%.
</finding-speed>

**UPDATE 1 — chunked-wasm attempt (8cea19dc):** generalized fit→chunked `FusedDCTTranspose<…,CL>`
(CL=lanes). SSSE3 proxy looked great: AVX2 +28.4%, **SSSE3 CL=4 +17.85%** — both byte-exact. Looked
wasm-capable.

**UPDATE 2 — REVERTED to fit-only (final commit `6f4e32ee`): the SSSE3 proxy LIED.** Drove the full
combined wasm e2e build (BASE f3dc93e5 vs COMB = +dct-fusion +acs-prune):
- **wasm e3 +5–10% SLOWER** (e3 has no ACS → isolates the DCT-fusion → it REGRESSES on wasm)
- wasm e5 −10 to −16% (the ACS-prune carrying it despite the DCT drag)
- byte-exact on the full encode: BASE vs COMB **SHA256-identical e3/e5/e6** ✓
Root cause: **WASM SIMD128 scalarizes `Transpose<8,4>`** (the chunked CL=4 path) — matches upstream
**f3dc93e5** ("revert DCT4X8 sink — scalar Transpose<8,4> regresses ~10%", David, same session). SSE
has an efficient 4×4 transpose; wasm does not → same lane count, opposite result. **Lesson: SSSE3
4-lane is NOT a valid proxy for wasm SIMD128 for transpose-heavy code; measure on the real wasm build.**
Reverted to the wide-vector (Lanes≥COLS = AVX2/AVX-512) fusion only → 4-lane falls back to the staged
path → wasm unaffected (0, no regression); native (Tauri batch) DCT8X8 keeps ~+24–28%.

## Run conclusion
- 1 perf finding, direct_fix (**6f4e32ee**, fit-only/native), byte-exact MEASURED (incl full-wasm-encode
  SHA cmp). AVX2 ~+24–28% on DCT8x8; **wasm = 0 (falls back, no regression)**.
- **NATIVE-only** → does NOT advance the wasm-e5 goal (the wasm encode tier falls back). Helps native batch.
- Combined-build value: caught + reverted a wasm regression the SSSE3 proxy had hidden.
- Dropped superseded branches: dct2x2 a61e500d, afv 999c6f17 (David's fe2a017b landed equivalents).
- **Run-Stop:** 2026-06-24T14:37Z. Branch on fe2a017b (dct-inl.h identical at f3dc93e5 → clean rebase).
  Teardown: `git worktree remove C:/Foo/rcw-sb-dctfuse` after merge.
