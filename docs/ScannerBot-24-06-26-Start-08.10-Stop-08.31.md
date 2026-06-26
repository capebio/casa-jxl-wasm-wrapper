---
scannerbot: 1
run_id: 24-06-26-0810
start: 2026-06-24T08:10Z
stop: 2026-06-24T08:31Z
mode: inline (patch-application + differential + flipflop, user-supplied handoff)
sweep_categories: [E, F]
target_root: external/libjxl-012/lib/jxl/enc_transforms-inl.h
branch: scannerbot/24-06-26-enctransforms-dct2x2   # SUBMODULE worktree branch off perf/acs-entropy-cleanups
worktree: C:/Foo/rcw-sb-dct2x2
tally: {arch: 0, perf: 1, mem: 0, bug: 0, correctness: 0, maint: 0, seam: 0, misc: 0}
disposition: {direct_fix: 1, adr_draft: 0, defer: 0, dropped_X: 0}
files_swept: 1
findings_total: 1
pipeline_estimate_pct: small-frequency-bound   # kernel +63.7% but DCT2X2 is a rare AC strategy (not profiled)
---

# Scannerbot Run 24-06-26-0810

| Run | Start | Stop | Duration | Files | Findings | direct_fix / adr / defer / dropped_X |
|-----|-------|------|----------|-------|----------|--------------------------------------|
| 24-06-26-0810 | 08:10 | 08:31 | ~21m | 1 | 1 | 1 / 0 / 0 / 0 |

**Run tally:** arch 0 · perf 1 · mem 0 · bug 0 · correctness 0 · maint 0 · seam 0 · misc 0
**Sweep:** user handoff (`DCT2X2` transform-path) → applied + differential + flipflop. Overlays V, X on.

> **Run shape.** User-supplied handoff with explicit invariants + a heavy validation-gate list
> (memcmp battery, impulses/ramps/checker, varied stride, all targets, sanitizers, corpus regression,
> frequency-weighted whole-encoder). Verified the byte-exact claim **by hand against the real source
> before applying**, then satisfied every locally-runnable gate. Same submodule-worktree isolation.

---

## File 001 — `external/libjxl-012/lib/jxl/enc_transforms-inl.h` (DCT2X2 path)

<!-- section-state: {started: 2026-06-24T08:10Z, ended: 2026-06-24T08:31Z,
     tally: {arch:0, perf:1, mem:0, bug:0, correctness:0, maint:0, seam:0, misc:0},
     findings: 1, lines_scanned: 810} -->

**Section tally:** perf 1 — 1 finding · focus DCT2TopBlock (66-97) + DCT2X2 case (556-561)
**Section time:** 08:10 → 08:31
**Commit:** `53a800f9` (submodule worktree branch `scannerbot/24-06-26-enctransforms-dct2x2`)

### perf

#### 001-E6-dct2x2 · perf · E6 allocation/copy elision (+ D3 staging shrink) — **LANDED**
- **where:** `lib/jxl/enc_transforms-inl.h:66-97` (replace `DCT2TopBlock`) + DCT2X2 case (556-561).
- **lens:** E6 (alloc/copy elision) + D3 (bulk-copy / staging shrink) · matched_lens: E6
- **disposition:** direct_fix · **change_class:** perf (integer-stable arithmetic; **bit-exact**)
- **severity:** medium (large local win, frequency-bounded e2e)
- **what:** The DCT2X2 path ran three `DCT2TopBlock<S>` passes, each with a 64-float `temp` +
  S*S copy-back. Pass 1 (8→4x4) has non-aliasing in/out (pixels vs coefficients) → its temp is pure
  overhead; the in-place <4>/<2> passes only need S*S floats. Split into `DCT2TopBlockNoAlias<8>`
  (direct write, no temp) + `DCT2TopBlockInPlace<4/2>` (minimal S*S stage). Arithmetic, `*0.25f`
  order, and coefficient layout unchanged.
- **byte-exact proof (independent):** verified by hand that NoAlias<8> direct-write equals the old
  temp+copy (in/out non-aliasing), and InPlace<S> reproduces the identical final S×S layout (only the
  temp's internal stride changes kBlockDim→S, which doesn't affect output; all `block` reads precede
  writes). The old `DCT2TopBlock` had no other caller.
- **prior_art_checked:** no match — R0 exit 0.
- **verification:** R0 ✔ · R1 — bench compiles+runs the logic; `enc_transforms.cc` foreach_target
  `-fsyntax-only` clean; full optimized build deferred ✔(partial) · R2 — **584-case differential**
  (random×9, const×6, impulse×128 [every input pos], ramp-h/v, checker) × strides {8,9,16,40},
  memcmp all 64 floats → **0 mismatches**; identical at -O2/native AND -O0/mssse3; **ASan+UBSan
  clean** (no OOB/UB) ✔ · R3 parity **bit-exact (max_abs_diff=0)** ✔ · R4 flipflop **+63.7% (2.75×)
  @-O2/native**, +27% @-O0, n=21 interleaved, tight IQR, bench parity 0/1048576 ✔ trust:high
- **commit:** `53a800f9`

<finding-speed id="001-E6-dct2x2">
n: 21
metric: total_ms
A_median_ms: 3.7352
B_median_ms: 1.3567
delta_pct: -63.68
A_iqr_ms: 0.0851
B_iqr_ms: 0.0522
trust: high
corpus: synthetic 8x8 blocks (16384/rep), full 3-pass DCT2X2, stride 8
size: DCT2X2 8x8 transform
parity: bit-exact
max_abs_diff: 0
lut_index_diff: 0
px_differ_count: 0
pipeline_share_pct: unmeasured-rare-strategy
pipeline_estimate_pct: small (DCT2X2 frequency bound; needs strategy-count build)
note: pure scalar → all Highway targets benefit. +27% even at -O0.
</finding-speed>

**Section summary:** Largest local win of the three runs (+63.7% / 2.75× kernel, bit-exact, exhaustively
differential-tested + sanitizer-clean). e2e bounded by DCT2X2 strategy frequency (rare).
**Section conclusion:** Clean, correct, well-verified staging elision. Banked.

### Deferred gate items (require full libjxl build — not runnable in-session)
- **G5 on-corpus encoded byte-exact** — `cmake --build build` from `external/libjxl-012`, encode the
  normal corpus old-vs-new, `cmp` outputs.
- **G6 whole-encoder frequency-weighted impact** — enable AC-strategy counts; weight the +63.7% by
  the measured DCT2X2 fraction. Expectation: small e2e (DCT2X2 is rarely selected), large per-call.

---
## Run conclusion
- **Swept:** 1 file · user handoff · mode=inline
- **Findings:** 1 (perf 1) · **Disposition:** direct_fix 1
- **Realized pipeline estimate:** kernel −63.7% (2.75×) bit-exact; **e2e small & frequency-bound**
  (DCT2X2 rare; whole-encoder measurement deferred to full build).
- **"Is it better?"** Yes vs AFV — ~7-10× larger local win, broader (all targets), far stronger
  correctness evidence (584-case diff + sanitizers). Same e2e caveat (rare strategy).
- **Build status:** R1 partial (syntax + bench); full optimized build + G5/G6 deferred.
- **Run-Stop:** 2026-06-24T08:31Z · **Duration:** ~21m
- **Worktree teardown:** `cd C:/Foo/raw-converter-wasm/external/libjxl-012;
  git worktree remove C:/Foo/rcw-sb-dct2x2` (branch holds 53a800f9).
