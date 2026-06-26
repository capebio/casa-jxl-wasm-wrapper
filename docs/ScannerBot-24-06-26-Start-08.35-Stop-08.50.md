---
scannerbot: 1
run_id: 24-06-26-0835
start: 2026-06-24T08:35Z
stop: 2026-06-24T08:50Z
mode: inline (user handoff — SIMD DCT2X2 first pass, stacked on stage 1)
sweep_categories: [D, E, F]
target_root: external/libjxl-012/lib/jxl/enc_transforms-inl.h
branch: scannerbot/24-06-26-enctransforms-dct2x2   # 2nd commit, stacked on stage-1 53a800f9
worktree: C:/Foo/rcw-sb-dct2x2
tally: {arch: 0, perf: 1, mem: 0, bug: 0, correctness: 0, maint: 0, seam: 0, misc: 0}
disposition: {direct_fix: 1, adr_draft: 0, defer: 0, dropped_X: 0}
files_swept: 1
findings_total: 1
pipeline_estimate_pct: small-frequency-bound   # DCT2X2 rare; big per-call, small e2e
---

# Scannerbot Run 24-06-26-0835 — DCT2X2 stage 2 (SIMD first pass)

| Run | Start | Stop | Duration | Files | Findings | direct_fix / adr / defer / dropped_X |
|-----|-------|------|----------|-------|----------|--------------------------------------|
| 24-06-26-0835 | 08:35 | 08:50 | ~15m | 1 | 1 | 1 / 0 / 0 / 0 |

**Run tally:** perf 1. **Sweep:** user handoff — SIMD the DCT2X2 `<8>` first pass (D1 SIMD layout).
Stacks on stage 1 (`53a800f9`). Overlays V, X on.

---

## File 001 — `external/libjxl-012/lib/jxl/enc_transforms-inl.h` (DCT2X2 first pass)

**Section tally:** perf 1 · **Commit:** `a61e500d` (branch `scannerbot/24-06-26-enctransforms-dct2x2`)

### perf

#### 001-D1-dct2x2simd · perf · D1 SIMD layout — **LANDED**
- **where:** `DCT2TopBlockNoAlias<8>` (the 8→4x4 first pass).
- **lens:** D1 (SIMD layout / deinterleave) · matched_lens: D1 · **change_class:** perf · bit-exact
- **what:** Vectorise the scalar first pass with Highway. `LoadInterleaved2` splits each input row
  into even lanes (c?0) / odd lanes (c?1); the four r-values are computed per-lane in the **exact**
  scalar op + `*0.25f` order (`s0=c00+c01` reused; **no FMA** — `Mul(Add(Add..)))` cannot fuse
  add+mul) and stored as contiguous quadrant rows. Guard `Lanes(d)==num_2x2` (4) selects the fast
  path; scalar fallback covers HWY_SCALAR. In-place `<4>/<2>` unchanged.
- **portability:** the fast path uses a 4-lane `CappedTag`, so SSE/AVX2/AVX-512-capped/NEON/**WASM**
  all take it — not AVX2-only.
- **prior_art_checked:** no match (R0 exit 0, run 24-06-26-0810).
- **verification:** R0 ✔ · R1 — bench runs the patched header (AVX2 + SSSE3); `enc_transforms.cc`
  foreach_target `-fsyntax-only` clean; full optimized build deferred ✔(partial) · R2 — **888-case
  differential** (random, const, impulse×128, ramps, checker, **signed-zero, subnormal**) × strides
  {8,9,16,40,64,95}, memcmp all 64 → **0 mismatch vs BOTH the original upstream scalar 3-pass AND the
  stage-1 scalar**; identical AVX2 & SSSE3; **ASan+UBSan clean** ✔ · R3 parity **bit-exact
  (max_abs_diff=0)** ✔ · R4 3-arm interleaved flipflop (16384 blk, n=21, contention-cancelled):
  orig ~252 → stage1 ~93 → SIMD ~51-54 ns/blk; **stage-2 +42-46% (1.73-1.84×) over stage1**
  (matches the handoff's 1.76-1.85× claim — local box ~1.8× slower absolute but ratio matches);
  **cumulative +78-80% (~4.7-5.0×) vs original**; trust:high ✔
- **commit:** `a61e500d`

<finding-speed id="001-D1-dct2x2simd">
n: 21
metric: total_ms
A_median_ms: 1.5231
B_median_ms: 0.8295
delta_pct: -45.54
A_iqr_ms: 0.1397
B_iqr_ms: 0.1295
trust: high
corpus: synthetic 8x8 blocks (16384/rep), 3-pass DCT2X2, stride 8; A=stage1-scalar B=SIMD
size: DCT2X2 8x8 transform
parity: bit-exact
max_abs_diff: 0
lut_index_diff: 0
px_differ_count: 0
pipeline_share_pct: unmeasured-rare-strategy
pipeline_estimate_pct: small (DCT2X2 frequency bound)
note: A=stage1 baseline; vs ORIGINAL upstream NEW is +78-80% (~4.7-5x). 4-lane CappedTag → wasm too.
</finding-speed>

**Section summary:** SIMD first pass delivers the handoff's claimed 1.73-1.84× over stage-1
(cumulative ~4.7-5× vs original), bit-exact across 888 cases + sanitizer-clean, portable (incl wasm).
**Section conclusion:** Validated + banked. e2e bounded by DCT2X2 strategy frequency (deferred to build).

### Deferred (full-build gates) — G5 on-corpus byte-exact, G6 frequency-weighted whole-encoder.

### Follow-ups proposed by user (NOT done here)
- **#2 SmallTransformCache** (share DCT4x4/DCT4x8 across DCT4X4/DCT4X8/AFV0-3) — **Category-A**:
  spans `enc_transforms` + `enc_ac_strategy` (FindBest8x8Transform/EstimateEntropy) + cache plumbing.
  Per scannerbot, architectural → `adr_draft`, not a unilateral edit. Needs design + sign-off.
- **#3** dct-inl.h paired-4x4 batching to fill SIMD lanes.

---
## Run conclusion
- **Findings:** 1 (perf 1) · direct_fix 1
- **Realized:** stage-2 +42-46% (1.73-1.84×) over stage1, bit-exact; cumulative ~4.7-5× vs original;
  e2e small & frequency-bound (deferred).
- **Build:** R1 partial (bench AVX2+SSSE3 + foreach_target syntax); full build + G5/G6 deferred.
- **Run-Stop:** 2026-06-24T08:50Z · **Duration:** ~15m
- **Teardown:** branch holds 53a800f9 + a61e500d; `git worktree remove C:/Foo/rcw-sb-dct2x2` after merge.
