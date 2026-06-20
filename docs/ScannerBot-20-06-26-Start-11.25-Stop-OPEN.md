---
scannerbot: 1
run_id: 20-06-26-1125
start: 2026-06-20T11:25Z
stop: 2026-06-20T11:42Z
mode: inline
sweep_categories: [A, B, C, D, E, F]
target_root: crates/raw-pipeline/src/decompress.rs
branch: ScannerBotDecompressDotRs
worktree: ../rcw-wt-scannerbot-decompress
tally: {arch: 0, perf: 0, mem: 0, bug: 0, correctness: 0, maint: 0, seam: 0, misc: 0}
disposition: {direct_fix: 0, adr_draft: 0, defer: 1, dropped_X: 0}
files_swept: 1
findings_total: 1
pipeline_estimate_pct: 0.0
---

# Scannerbot Run 20-06-26-1125

| Run | Start | Stop | Duration | Files | Findings | direct_fix / adr / defer / dropped_X |
|-----|-------|------|----------|-------|----------|--------------------------------------|
| 20-06-26-1125 | 11:25 | 11:42 | 17m | 1 | 1 | 0 / 0 / 1 / 0 |

**Run tally:** arch 0 · perf 0 · mem 0 · bug 0 · correctness 0 · maint 0 · seam 0 · misc 0  (banked-to-production: **0**)
**Sweep:** Category A–F on `crates/raw-pipeline/src/decompress.rs` (single named file) · overlays V, X always on · mode=inline

**Branch-safety note:** base = `main` (216257ac). Verified `decompress.rs` blob `69850ff9` is **byte-identical** on `main` and every active branch (crawlbot/*, perf/mhc-demosaic, ProgressiveJXLEncodeBunch); the only branches ahead of main do not touch this file → no stale-base hazard for this target.

**Prior context (in-file empirical rejections, honored):** `d3_one_fill_bench_reject` (single fill(48) + get_unchecked measured 0.3%, REJECT) and `d6_skip_zero_init_reject` (MaybeUninit, unsound surface for ~2–4ms, REJECT). The file already banks ea3fca93 (branchless predictor, 1.27×), D1 delay-lines, D2 `leading_zeros` nbits, batch-fill-to-56 BitReader, OnceLock huff.

---

## File 001 — `crates/raw-pipeline/src/decompress.rs`

<!-- section-state: {started: 2026-06-20T11:25Z, ended: 2026-06-20T11:42Z,
     tally: {arch:0, perf:0, mem:0, bug:0, correctness:0, maint:0, seam:0, misc:0},
     findings: 1, lines_scanned: 401} -->

**Section tally:** perf 0 banked · 1 measured-reject — 1 finding · scanned 401 LOC
**Section time:** 11:25 → 11:42
**Commit:** _see run commit below_

### perf

#### 001-D-parity-unroll · perf · D (kernel) / E4 (register-keeping) · **REJECT**
- **where:** `decompress_rows_into` per-pixel column loop (`decompress.rs:85-167`)
- **lens:** D (kernel/memory) + E4 (invariant/register hoist) · matched_lens: D/E4
- **disposition:** **defer** (measured-reject — built bit-exact, failed R4)
- **change_class:** perf
- **severity:** n/a (rejected)
- **what:** Unroll the column loop ×2 so even (parity 0) / odd (parity 1) columns each
  get scalar `acarry`/`west`/`north_west` locals (`a0/a1`, `w0/w1`, `nw0/nw1`) instead of
  one `[[i32;3];2]` indexed by `col & 1`, killing the dynamic index so the running-average
  chain stays in registers. Implemented via an **inline `macro_rules!`** (not a closure —
  X8: closures have blocked inlining / regressed −50% here).
- **rationale:** release asm of `decompress_rows_into` showed 135 stack-memory operands
  (`[rsp+40]`×23 hottest), suggesting `acarry`/`west`/`nw` spill to stack on the serial
  dependency chain — the shape D/E4 pays out on.
- **prior_art_checked:** R0 `no match` (X1–X9 + `rejected optimizations.md`). Distinct from
  the in-file D3 (fill batching) and D6 (zero-init) rejections.
- **verification:** R0 ✔ · R1 build ✔ · R2 `cargo test --no-default-features --lib decompress` ✔ ·
  R3 parity **bit-exact** (golden + random even/odd/width-1, max_abs_diff=0) ✔ ·
  **R4 flipflop ✘ — sub-gate, trust:low**
- **verdict:** **REJECTED.** Reverted to original (production decode code unchanged,
  diff = +17/−0 = the `parity_unroll_reject` ignore-note test only). Logged to
  `docs/rejected optimizations.md` (2026-06-20 section) so a future R0 catches it.

<finding-speed id="001-D-parity-unroll">
n: 5
metric: total_ms
A_median_ms: 63.9
B_median_ms: 62.5
delta_pct: +0.5            # MEAN over 5 warm runs; SIGN-UNSTABLE (+6.7/-2.6/-2.6/-1.3/+2.2)
A_iqr_ms: ~12              # array ref swung 56-100 ms run-to-run (thermal)
B_iqr_ms: ~12
trust: low                 # V1 thermal: ±4-6% cross-run noise band; cannot bank
corpus: synthetic-Olympus-bitstream (deterministic LCG bytes)
size: 5239x600 (3.1 MP, odd width -> ×2 tail every row)
parity: bit-exact
max_abs_diff: 0
lut_index_diff: 0
px_differ_count: 0
pipeline_share_pct: n/a
pipeline_estimate_pct: 0.0   # nothing banked
journal: inline (harness not retained; see rejected optimizations.md 2026-06-20)
</finding-speed>

### Other levels swept — no banked change

- **C5 traversal/kernel fusion:** the decode is already single-pass; output is written
  zero-copy into the caller-owned `out` (`decompress_rows_into`). No second pass to fuse,
  no copy to remove.
- **D3 / D6 (fill batching, zero-init elision):** already measured-and-rejected in-file
  (`d3_*`, `d6_*`). Honored — not re-chased.
- **E (BitReader single-fill-per-pixel + consolidated `br.truncated` check):** would remove
  ~6 *predicted* branches/pixel. On a loop the parity-unroll just proved is **latency-bound**
  (not throughput-bound), predicted-branch removal has a strictly lower ceiling than the
  unroll — below this box's ±4–6% measurement noise floor (V5). Not implemented: a sub-noise
  reasoned guess is not bankable and would not be honestly measurable now.
- **F (correctness/overflow/`unsafe`):** clean. `checked_mul` guards the `w*h` allocation;
  the escape path (`extra = 16 - nbits`) is `saturating_sub`-guarded and `nbits ≤ 16`;
  `high << nbits`, `diff*3`, `(diff<<2)|low` all stay within i32 then mask to 16 bits — no
  overflow. The one `unsafe { *cur_row_ptr.add(col) }` is bounded by the `col < width` loop
  invariant on a `&mut cur[..width]` slice, disjoint from the `north_row` borrow via
  `split_at_mut` (SAFETY comment + SEC-004/PARSERS-013/CONC-05 already pin it). Truncation
  accounting (`real_in_buf`/`padded`) is test-covered (`truncated_input_errors_d4`).
- **B (structural/ABI):** pure-Rust, no FFI/serialization boundary; the `decompress_rows_into`
  return-value contract (returns `rows` written, tail untouched) is documented and tested
  (`decompress_rows_into_prefix_matches_and_reports_rows_written`).
- **A (arch):** correctly placed — a leaf decoder called by `tiff.rs` / `lib.rs` /
  `jxl_casadecoder.rs`. No layer-boundary leak.

**Section summary:** One genuine perf candidate (parity-unroll) found, built bit-exact, and
measured — rejected at the ≥5% gate (mean ~+0.5%, sign-unstable, trust:low). All other levels
swept; no banked change. File reverted to original + a rejection-note test added.

**Section conclusion:** `decompress.rs` is **perf-saturated for single-thread micro-opts.**
The Olympus VLC decode is bit-serial and latency-bound on the stream + 8 KB huff table-load;
ea3fca93's branchless predictor (1.27×) is the achievable single-thread win and is already
banked. Correctness/overflow/`unsafe` are clean and well-tested. The only remaining speedup
axis is structural (e.g. per-strip threading) — out of scope for a micro-opt sweep, not an
ADR this run surfaced as ready.

---

## Penultimate sweep (gap-in-lenses)
No cluster of ≥2 unmatched (`matched_lens==none`) findings — the single candidate matched
D/E4 cleanly. No candidate new lens proposed.

## Seam analysis
1-hop neighbours of `decompress.rs`: `tiff.rs`, `lib.rs`, `jxl_casadecoder.rs` (callers).
C6 (zero-copy) + B1 (ABI/stride) over the boundary: callers already use
`decompress_rows_into(&mut out)` — the decode writes directly into the caller buffer with no
intermediate copy and no stride/ABI mismatch (pure-Rust `&mut [u16]`). Seam clean. No
follow-up target accrued a seam finding.

## Unifying sweep
Single-file run — no ≥2-file cross-cutting opportunity in scope. No `adr_draft` raised.

## Follow-up targets
None. (A future *throughput* axis — per-strip/per-row threading of Olympus decode behind a
`cfg(feature="parallel")` gate, lens D4 — is a structural ADR, not a micro-opt; record for a
future architectural pass if RAW decode batch latency becomes a cost centre.)

---
## Run conclusion
- **Swept:** 1 file · 401 LOC · Category A–F · mode=inline
- **Findings:** 1 (perf 1 — measured-reject)
- **Disposition:** direct_fix 0 · adr_draft 0 · defer 1 · dropped_X 0
- **Banked to production:** 0 perf / 0 bugfix. Production decode code **byte-for-byte unchanged**
  (diff = +17/−0: a `#[ignore]` `parity_unroll_reject` rejection-note test, in the file's own
  `d3`/`d6` idiom).
- **Also written:** `docs/rejected optimizations.md` 2026-06-20 section (repo-wide immune
  memory; `prior-art.mjs` greps it so a future R0 catches the parity-unroll).
- **Realized pipeline estimate:** 0.0% (nothing banked — the file was already at its
  single-thread floor on entry).
- **Termination state:** **code-saturated · 0 adr_drafts pending.** A re-run banks nothing
  (idempotent): the one perf candidate is measured-rejected, all other levels are clean.
- **Run-Stop:** 2026-06-20T11:42Z · **Duration:** 17m
