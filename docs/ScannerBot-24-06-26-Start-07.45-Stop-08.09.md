---
scannerbot: 1
run_id: 24-06-26-0745
start: 2026-06-24T07:45Z
stop: 2026-06-24T08:09Z
mode: inline (patch-application + flipflop, user-supplied diff)
sweep_categories: [E, F]
target_root: external/libjxl-012/lib/jxl/enc_transforms-inl.h
branch: scannerbot/24-06-26-enctransforms-afv     # SUBMODULE worktree branch off perf/acs-entropy-cleanups
worktree: C:/Foo/rcw-sb-enctrans
tally: {arch: 0, perf: 1, mem: 0, bug: 0, correctness: 0, maint: 0, seam: 0, misc: 0}
disposition: {direct_fix: 1, adr_draft: 0, defer: 0, dropped_X: 0}
files_swept: 1
findings_total: 1
pipeline_estimate_pct: negligible    # AFV is a rare AC strategy; e2e share tiny (not profiled)
---

# Scannerbot Run 24-06-26-0745

| Run | Start | Stop | Duration | Files | Findings | direct_fix / adr / defer / dropped_X |
|-----|-------|------|----------|-------|----------|--------------------------------------|
| 24-06-26-0745 | 07:45 | 08:09 | ~24m | 1 | 1 | 1 / 0 / 0 / 0 |

**Run tally:** arch 0 · perf 1 · mem 0 · bug 0 · correctness 0 · maint 0 · seam 0 · misc 0
**Sweep:** user-supplied patch `tmp/enc_transforms-inl.afv-cleanup.patch` → applied + flipflop'd.
Overlays V, X always on · mode=inline.

> **Run shape.** User supplied a diff (`AFVTransformFromPixels` cleanup) and asked to implement it
> and interleave-flipflop the diff. Not a lens-discovery sweep — one finding (the patch), held to the
> full acceptance gate. Same submodule-worktree isolation as run 24-06-26-0657. Ledger uncommitted.

---

## File 001 — `external/libjxl-012/lib/jxl/enc_transforms-inl.h`

<!-- section-state: {started: 2026-06-24T07:45Z, ended: 2026-06-24T08:09Z,
     tally: {arch:0, perf:1, mem:0, bug:0, correctness:0, maint:0, seam:0, misc:0},
     findings: 1, lines_scanned: 810} -->

**Section tally:** perf 1 — 1 finding · scanned ~810 LOC (focus: AFVTransformFromPixels 407-455)
**Section time:** 07:45 → 08:09
**Commit:** `999c6f17` (submodule worktree branch `scannerbot/24-06-26-enctransforms-afv`)

### perf

#### 001-E-afv · perf · E4 invariant/dead-code + E6 alloc-elision + E1 constexpr — **LANDED**
- **where:** `lib/jxl/enc_transforms-inl.h:407-455` (`AFVTransformFromPixels`) + 4 call sites in
  `TransformFromPixels` (608/612/616/620).
- **lens:** E4 (dead-store / invariant) + E6 (allocation elision) + constexpr branch-elim ·
  matched_lens: E4
- **disposition:** direct_fix · **change_class:** perf (integer-stable; **bit-exact**, no FP reassoc)
- **severity:** low (rare strategy)
- **what:** Four-part cleanup of the AFV forward transform:
  1. Take `scratch_space` from the caller (drop the per-call `HWY_ALIGN float[160]` local **and** the
     separate `coeff[16]`; the caller's scratch is ≥2048 floats — verified vs the 160 needed).
  2. `afv_x`/`afv_y` → `constexpr` → the 4 template kinds compile-time-eliminate the `?:` branches.
  3. Drop the `block[32] = {}` zero-init (provably never read uninitialized once (4) lands).
  4. The (odd,even) DCT4x4 copy loop ran `ix < 8`, but `ComputeScaledDCT<4,4>` fills only a 4-wide
     row; `ix>=4` read past the row and wrote (odd,odd) coefficients that the **following** DCT4x8
     loop (lines 444-447, rows{1,3,5,7}×cols{0..7}) overwrites in full → **dead stores**. Trim to
     `ix < 4`.
- **rationale:** E4 — the `ix>=4` writes are dead (later fully overwritten; proven by index coverage),
  and the zero-init they depended on then disappears; E6 — caller scratch removes a 160-float stack
  buffer + a 16-float buffer per call; constexpr specializes the 4 instantiations.
- **prior_art_checked:** no match — R0 `prior-art.mjs` exit 0.
- **verification:** R0 ✔ · R1 — patched header **compiles + runs** in the bench (AVX2) and
  `enc_transforms.cc` foreach_target `-fsyntax-only` clean (host, shimmed export/version); full
  optimized build deferred ✔(partial) · R2 n/a (standalone parity oracle) · R3 parity **bit-exact
  (max_abs_diff=0, px_differ 0/524288 across all 4 AFV kinds)** ✔ · R4 flipflop ≥5% — 4 runs, NEW
  faster every run, +5.1..+14.6% (box-contention noisy) ✔ trust:medium (direction high; magnitude ±)
- **commit:** `999c6f17`

<finding-speed id="001-E-afv">
n: 21
metric: total_ms
A_median_ms: 5.571
B_median_ms: 5.285
delta_pct: -5.14
A_iqr_ms: 0.172
B_iqr_ms: 0.242
trust: medium
corpus: synthetic 8x8 pixel blocks (8192/kind × 4 AFV kinds), stride 8
size: AFV 8x8 transform
parity: bit-exact
max_abs_diff: 0
lut_index_diff: 0
px_differ_count: 0
pipeline_share_pct: unmeasured-small
pipeline_estimate_pct: negligible
note: 4 runs under contention all ≥5% NEW-faster (+6.2/+9.2/+5.1/+14.6); cleanest run (tightest IQR) = +5.14% recorded above. Not lane-gated → wasm benefits too.
</finding-speed>

**Section summary:** Applied the user's AFV cleanup patch; byte-exact, kernel ~5-9% (contention-noisy),
benefits all targets. e2e negligible (AFV rarely chosen, esp. at e3).
**Section conclusion:** Clean, correct cleanup with a genuine dead-store removal at its core. Banked.

---
## Run conclusion
- **Swept:** 1 file · ~810 LOC · user-supplied patch · mode=inline
- **Findings:** 1 (perf 1) · **Disposition:** direct_fix 1
- **Realized pipeline estimate:** negligible e2e (AFV is a rare AC strategy; kernel ~5-9% byte-exact)
- **Build status:** R1 partial — bench runs the patched header + `enc_transforms.cc` foreach_target
  syntax-clean; **full optimized build deferred** (`cmake --build build` from `external/libjxl-012`,
  then re-encode + byte-compare).
- **Termination state:** patch applied + verified; code-saturated for this scope.
- **Run-Stop:** 2026-06-24T08:09Z · **Duration:** ~24m
- **Worktree teardown (after merge/inspection):**
  `cd C:/Foo/raw-converter-wasm/external/libjxl-012; git worktree remove C:/Foo/rcw-sb-enctrans`
  (branch `scannerbot/24-06-26-enctransforms-afv` holds commit 999c6f17).
