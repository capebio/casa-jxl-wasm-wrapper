# Branch Consolidation — "One Head Per Repo"

**Date:** 2026-06-30
**Goal:** Collapse the scattered branch/worktree state (super + sub) down to a single
clean head per repo, merging verified work into `main`, without losing real work and
without introducing a perf regression.

## Context

Two-repo structure (kept, by decision):

```
super (app)  C:\Foo\raw-converter-wasm        main @ 8bdf8c09  = origin/main
  └─ external/libjxl-012 (submodule, fork)     main @ 00f4d7fc  = capebio/main
        origin = upstream libjxl-core (33b7a9f6)
        capebio = our fork
```

The submodule is a **deliberate choice** (clean upstream-libjxl pulls + separate fork
history), not a necessity. Decision: **keep the submodule**, just remove the clutter.

### Current clutter

- **Super:** 9 extra branches, all in worktrees `C:\Foo\rcw-*`. None merged into `main`.
- **Sub:** 9 extra branches (8 in worktrees). Only `enc-cluster-mergecost-reuse-h7q3`
  is already merged into `capebio/main`.

### The work is ~80% pre-assembled

Two integration branches already stack the jun30 work:

- **`integrate-jun30` (sub @ 241444aa)** — 6 byte-exact libjxl opts on `capebio/main`:
  ans_common, dec_group X-zero, enc_bit_writer, enc_cluster, quant_weights, quantizer.
  The q9z3k↔q5x7 `quantizer.cc SetQuantField` collision is **already resolved** here
  (commit msg: "quantizer byte-exact (q5x7) over quant-weights (q9z3k)").
  Subsumes feature branches: ans-common, dec-xzero, enc-bitwriter, enc-cluster-fuse,
  quant-weights, quantizer.
- **`integrate-super-jun30` (super @ 06aa0208)** — all raw-pipeline opts (perceptual BCE,
  ljpeg micro-ops, lib.rs LE-pack/hoist, PIPE-015 black-frame fix, jxl encoder
  output-drain fix) **+ bumps the gitlink → `241444aa`** (the new sub head).
  Subsumes feature branches: librs-microops, ljpeg, perc-oracle, pipeline-simd,
  jxl-enc-drain, quant-weights-docs.

### Pre-existing decode regression (OUT OF SCOPE, documented)

Current `main` gitlink `00f4d7fc` already contains `8f505e2e perf(dec_ans): cut
decode-setup allocations` — the suspected ~15% WASM-decode regressor (per
`project-dec-wasm-regression-20260630`). `integrate-jun30` is built **on top of**
`00f4d7fc`, so it **inherits but does not add** this regression. Fixing it is a
**separate campaign** and is not part of this consolidation. The Phase-1 dec flipflop
will show it only as a pre-existing baseline delta; it does not block the merge.

## Constraints

- **Correctness:** every opt in both integrate branches is **byte-exact** (identical
  output bytes, native A/B-proven via the `tools/*_ab.cc` harnesses). Merging therefore
  carries **zero correctness risk**.
- **Perf:** byte-exact ≠ perf-safe in WASM (the `dec_ans` precedent regressed WASM speed
  while staying byte-exact). So a **WASM flipflop gate** is required before merge — this
  is the project's standing "integrator gate = WASM A/B" rule.
- **Git safety:** this is the **primary checkout on `main`**. Only forward-commits onto
  `main` are allowed here (merging integrate-super → main qualifies). **Never switch the
  primary checkout's branch.** Verification builds run in the **existing**
  `rcw-integrate-super` / `rcw-integrate-sub` worktrees, never in the primary tree.
- Pushed branches on `origin`/`capebio` are safe backups; deletion is reversible until
  the remote ref is also deleted.

## Plan

### Phase 1 — WASM-gate verify the integrate stack
1. In `rcw-integrate-sub` ensure sub HEAD = `integrate-jun30 (241444aa)`; in
   `rcw-integrate-super` ensure super HEAD = `integrate-super-jun30 (06aa0208)` with its
   submodule checked out at `241444aa`.
2. Rebuild WASM from the integrated tree (`packages/jxl-wasm` build, `--include-mt`).
3. Run **enc** flipflop A/B (integrated vs current `main`) and **dec** flipflop A/B.
4. Green (no regression beyond the known pre-existing dec delta) → Phase 2.
   Regression in a specific opt → bisect within the integrate stack, drop that opt,
   re-verify.

### Phase 2 — Merge integrates to main
1. Sub: advance `main`/`capebio/main` **to** `integrate-jun30` — it is built directly on
   `capebio/main`, so this is a fast-forward (`git -C external/libjxl-012 merge --ff-only
   integrate-jun30` while on sub `main`). Push `capebio/main`.
2. Super: while on super `main`, merge `integrate-super-jun30` **into** `main`
   (fast-forward forward-commit; gitlink already `241444aa`). Confirm the gitlink resolves
   to the new sub `main`. Push `origin/main`.

### Phase 3 — Triage orphans (not in either integrate)
- `perf/enc-conv5-edge-coverage-z3k` (super+sub) — byte-exact, but app callers are all
  full-image (upstream-robustness only). Verify, merge only if it shows a real gate win;
  else park on remote.
- `perf/enc-aq-masking-batch-jun29-m8b` (sub) — byte-exact, AVX2 +11%, **WASM unmeasured**.
  WASM-measure; merge if it ports, else park.
- `perf/enc-conv5-xtile-jun29-v7k` (sub) — **REJECTED** (regression). Delete, keep notes.
- `verify/enc-modular-q4z-jun29` (super) — verify scaffold/tooling, not a perf change.
  Keep as tooling on remote or fold harness into `tools/`; delete worktree.
- `perf/enc-cluster-mergecost-reuse-jun30-h7q3` (sub) — already in `capebio/main`. Delete.

### Phase 4 — Prune branches + worktrees
1. For each subsumed feature branch, confirm `git log integrate..branch` is empty
   (fully subsumed) **before** deleting.
2. Remove worktrees (`git worktree remove`) — super: rcw-conv5edge, rcw-integrate-super,
   rcw-jxl-enc-drain, rcw-librs-microops, rcw-ljpeg, rcw-perc-oracle, rcw-pipeline-simd,
   rcw-quant-weights-docs, rcw-verify; sub: rcw-ans-common, rcw-conv5-xtile, rcw-dec-xzero,
   rcw-enc-bitwriter, rcw-enc-cluster, rcw-integrate-sub, rcw-quant-weights, rcw-quantizer.
3. Delete local branches; delete remote refs only for rejected/fully-merged ones, keep
   remote backups for any parked orphan.

### Phase 5 — Settle
- Clean `git status` in both repos (resolve the stray `third_party/zlib` pointer and the
  pre-existing unstaged dist/docs/test files — stage or discard intentionally).
- Verify one head per repo: `git branch` shows only `main` (super) and only `main`
  (sub, = capebio/main).
- Push both.

## Success criteria

- `git branch` in super → `main` only; in sub → `main` only.
- `git worktree list` → primary checkout only (per repo).
- `git status` clean in both repos.
- All verified byte-exact opts present in `main` / `capebio/main`; no perf regression
  vs prior main on the enc/dec flipflop (excluding the documented pre-existing dec delta).
- Any not-merged work survives on a remote branch (nothing lost).

## Out of scope

- Fixing the pre-existing `dec_ans` ~15% WASM-decode regression (separate campaign).
- Pulling upstream libjxl updates.
- Vendoring the submodule (explicitly rejected; submodule kept).
