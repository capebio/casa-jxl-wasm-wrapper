---
scannerbot: 1
run_id: 20-06-26-1612
start: 2026-06-20T14:12Z
stop: OPEN
mode: inline
sweep_categories: [A, B, C, D, E, F]
target_root: crates/raw-pipeline/src/dng.rs
branch: scannerbot/20-06-26-start-16.12
worktree: ../rcw-wt-scannerbot-20-06-26-1612
tally: {arch: 0, perf: 0, mem: 0, bug: 0, correctness: 0, maint: 1, seam: 0, misc: 0}
disposition: {direct_fix: 1, adr_draft: 0, defer: 2, dropped_X: 0}
files_swept: 1
findings_total: 3
pipeline_estimate_pct: 0.0
---

# Scannerbot Run 20-06-26-1612

| Run | Start | Stop | Duration | Files | Findings | direct_fix / adr / defer / dropped_X |
|-----|-------|------|----------|-------|----------|--------------------------------------|
| 20-06-26-1612 | 16:12 | OPEN | — | 1 | 3 | 1 / 0 / 2 / 0 |

**Run tally:** arch 0 · perf 0 · mem 0 · bug 0 · correctness 0 · maint 1 · seam 0 · misc 0
**Sweep:** Category A+B+C+D+E+F on `crates/raw-pipeline/src/dng.rs` · overlays V, X always on · mode=inline

---

## File 001 — `crates/raw-pipeline/src/dng.rs`

<!-- section-state: {started: 16:12, ended: 16:35,
     tally: {arch:0, perf:0, mem:0, bug:0, correctness:0, maint:1, seam:0, misc:0},
     findings: 3, lines_scanned: 1611} -->

**Section tally:** maint 1 — 3 findings · scanned 1611 LOC
**Section time:** 16:12 → 16:35
**Commit:** _pending_

**Context.** `dng.rs` is a *mature, hard-swept* file: dozens of prior guards
(`000-security-*`, `DNG-*`, `SEC-*`, `PARSERS-*`, `ERR-*`) and the EpicCodeReview
raw-pipeline pass (54 banked fixes) already mined the perf lenses. Applied lens shapes
already present: **D2** MHC interior boundary-split, **D3** `fill_u16_row` LE-memcpy,
**C5** fused decode+demosaic (`decode_bytes_demosaiced`), **D4** per-tile parallel decode.
Expect few new banks — confirmed: one maint cleanup, two deferrals, zero correctness bugs.

### maint

#### 001-E-div0 · maint · E (strength-reduction / clarity)
- **where:** `dng.rs:180-181, 323-324, 1433-1434` (3 pairs)
- **lens:** E3-adjacent (strength reduction) → derived category **maint**
- **disposition:** direct_fix
- **change_class:** maint (code-quality; not a measured perf claim — V5 noise floor)
- **severity:** low
- **what:** replace the ceiling-division idiom `(width + tw - 1) / tw` with
  `width.div_ceil(tw)` at all 3 `coltiles`/`rowtiles` pairs.
- **before:** ```rust
let coltiles = (width + tw - 1) / tw;
let rowtiles = (height + tl - 1) / tl;
```
- **after:** ```rust
let coltiles = width.div_ceil(tw);
let rowtiles = height.div_ceil(tl);
```
- **rationale:** removes the overflow-prone intermediate add (`width + tw - 1` can wrap
  for hostile dims; `div_ceil` cannot) and the `+ n - 1` idiom the surrounding security
  comments repeatedly have to reason about. `tw`/`tl` are guarded `> 0` immediately above
  each site, so the result is identical for the entire valid domain. Rust 1.73+ /
  toolchain 1.95.
- **prior_art_checked:** no match (X1–X9 + rejected-optimizations.md), prior-art.mjs exit 0
- **verification:** R0 ✔ · R1 build ✔ · R2 `cargo test --no-default-features --lib`
  148 passed / 8 ignored (== baseline) ✔ · R3 parity bit-exact by construction
  (`a.div_ceil(b) ≡ (a+b-1)/b ∀ b>0`; max_abs_diff=0, lut_index_diff=0, px_differ_count=0) ✔
  · R4 n/a (maint, not perf — V5)
- **commit:** _pending_

### defer (recorded, not banked)

#### 001-C6-blit · defer · C6 (zero-copy boundary)
- **where:** `decode_tiles` `dng.rs:202-280` (compact per-tile `Vec` + serial blit into `out`)
- **what:** the parallel path decodes each tile into a private `vec![0u16; bw*bh]`, then
  serially `copy_from_slice`s every pixel into `out` (a full-image extra pass, ~48 MB @24MP).
  A strided direct-into-`out` decode (as the demosaiced band path already does via
  `ljpeg::decode_tile(.., col_start, stride, ..)`) would remove the blit + per-tile alloc.
- **why deferred:** the compact+blit is a **deliberate, comment-documented tradeoff**
  ("Replaces the prior row-of-tiles band + Mutex + inner serial cols") chosen for full
  per-tile load-balancing over row-band parallelism. Direct strided write under rayon needs
  disjoint `&mut` rects (unsafe ptr or row-tile chunking) and would coarsen parallelism —
  re-litigating a settled decision. Needs flipflop proof that blit-cost > parallelism-loss
  before touching. → QUESTIONS.md.

#### 001-F-align · defer · F (correctness, colour)
- **where:** `align_to_rggb` `dng.rs:438-478` (Grbg/Bggr stride-vs-width contract)
- **what:** memory flags `align_to_rggb` Grbg/Bggr as a high-risk deferred colour concern
  (stride returned, not logical width; caller must compute `stride - col_off` itself).
- **why deferred:** function is **test-only** — no production caller (`decode_bytes` →
  `process_dng_impl` uses `cfa_phase`, not `align_to_rggb`). Cannot be confirmed
  buggy in isolation (it is a stride contract, not a computation), and colour changes
  require the headless visual gate per auto-apply policy. Already on the EpicCodeReview
  deferral list. → no new action; left as-is.

### examined, no finding (X / not-a-bug)
- `read_ascii` `dng.rs:1007-1013` inline branch uses raw `data[inline_pos..inline_pos+cnt]`
  (unlike every other reader's `.get()`). **Verified safe:** `visit_ifd` (tiff.rs:572)
  guarantees the full 12-byte entry is in-bounds before the visitor runs, so
  `inline_pos = e+8` ⇒ `inline_pos+4 ≤ data.len()`, and `cnt ≤ 4` ⇒ in-bounds. Not a finding.
- `decode_bytes_demosaiced` fused X2 path (`dng.rs:1283-1610`, ~300 LOC) has **no production
  caller** (test-only; wasm uses `decode_dng_raw`→`decode_bytes`). Architectural dead-weight —
  but **already tracked** in `QUESTIONS.md` + `docs/rejected optimizations.md`; not re-raised
  (no duplicate adr_draft).

**Section summary:** 1 maint cleanup banked (div_ceil ×3 pairs, bit-exact); 2 deferrals
(C6 blit — settled parallelism tradeoff; F align_to_rggb — test-only colour contract,
already deferred); 0 correctness bugs (read_ascii proven safe).
**Section conclusion:** file is at the perf floor for C/D/E — the seam wins are already
banked. No safe perf lever remains without re-opening a documented tradeoff. Code-saturated.

---

## Seam analysis
1-hop neighbors of `dng.rs`: `tiff.rs` (visit_ifd — inspected for the read_ascii bound,
clean), `demosaic.rs`, `ljpeg.rs` (decode_tile / decode_tile_compact / probe_tile).
Seam lenses C6+B1 over the `dng↔ljpeg` boundary: the tile ABI (`src` byte-slice in,
strided/compact `&mut [u16]` out) is consistent; no stride drift. No seam findings.

## Follow-up targets
None promoted (no adjacent file accrued a V-gated seam finding).

## Unifying sweep
Single-file run — no ≥2-file cross-cutting opportunity to evaluate. n/a.

---
## Run conclusion
- **Swept:** 1 file · 1611 LOC · Category A+B+C+D+E+F · mode=inline
- **Findings:** 3 (maint 1 · defer 2)
- **Disposition:** direct_fix 1 · adr_draft 0 · defer 2 · dropped_X 0
- **Realized pipeline estimate:** 0.0% (the only bank is maint/code-quality, not a perf change)
- **Top wins:** 001-E-div0 (div_ceil ×3, bit-exact, clarity + overflow-safety)
- **Termination state:** code-saturated · 0 adr_drafts pending · 2 deferrals (both already
  on existing backlogs)
- **Deferred → QUESTIONS.md** (run 20-06-26-1612)
- **Run-Stop:** _pending_ · **Duration:** _pending_
