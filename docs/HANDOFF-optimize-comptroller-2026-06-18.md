# HANDOFF — optimize-codec-times + comptroller-loop (2026-06-18)

Branch: `jxl-scheduler-20260618` · Safety tag: `safety/pre-recovery-20260618`

## TL;DR
Built two agent workflows for cutting enc/dec times. The big tournament (`optimize-codec-times`)
is built but **only proven via probe** — its two real runs were ruined by a config bug (now fixed).
The small supervised `comptroller-loop` is **verified working** (Haiku workers + Sonnet comptroller,
one-batch find→validate→fix→report, per-file branch in a worktree). Next: escalate the comptroller
loop. First: clean up litter from the bad runs.

## CRITICAL — how to launch a Workflow correctly (learned the hard way)
1. **`args` arrives as a JSON STRING, not an object.** Scripts MUST parse it:
   `const A = typeof args === 'string' ? JSON.parse(args) : (args||{})`. Both new workflows do.
   The two 5-hour runs happened because `args?.targetPath` on a string is `undefined` → every
   config silently defaulted to the full workflow.
2. **Do NOT launch by `{name:...}`** — it resolves to a STALE cached snapshot, ignoring your latest
   edits. **Launch by `scriptPath`** pointing at the canonical file, e.g.
   `Workflow({scriptPath: "C:\\Foo\\raw-converter-wasm\\.claude\\workflows\\comptroller-loop.js", args: {...}})`.
3. **Probe first, always.** `args:{__probe:true, ...}` returns in <50ms, 0 agents, echoing the parsed
   config. Both workflows have the probe guard. If it spawns an agent, config didn't bind — STOP.
4. **NEVER run two perf workflows concurrently** — CPU/thermal confound faked "wins" + two agent
   processes committing to one tree caused the mess below.
5. Verify/fixer agents run in **worktree isolation**, are forbidden git-on-main, and must not edit the
   benchmark harness (`StandardMultifileTest.mjs`) — edit the production caller.

## What's built + committed
- `benchmark/optimize/` helpers (pure, TDD): `harness-dump`, `baseline-parse`, `gate`,
  `flipflop-testgen`, `manifest`, `coverage` (+ `lensStats`). **24 tests green:**
  `node --test benchmark/optimize/test/*.test.mjs` (Node 24 needs the glob, not a bare dir).
- `.claude/workflows/optimize-codec-times.js` — tournament: 6 lenses (aerial→seam→architecture→
  operational→mathematical→tactical), folder mode (DIR or single FILE + surrounding), `findOnly`,
  lens selection (`lenses` whitelist / `excludeLenses` blacklist), coverage ledger, gated C++.
  **Built, probe-verified, NOT yet run end-to-end successfully.**
- `.claude/workflows/comptroller-loop.js` — **VERIFIED WORKING.** Haiku workers + Sonnet comptroller,
  ≤3 findings → validate → fix (worktree + `fix/<file>` branch) → report → STOP. Run on `loader.ts`:
  branch `fix/packages-jxl-wasm-src-loader-ts` commit `8c2858fe` (isolated, +4/−3, NOT merged) —
  removed an unsafe cast + a dangerous fallthrough. Obeyed every rein. ~5 min, 4 agents, 118K tokens.
- Specs/plans/usage: `docs/superpowers/specs/2026-06-18-optimize-codec-times-workflow-design.md`,
  `docs/superpowers/plans/2026-06-18-optimize-codec-times-workflow.md`, `docs/optimize-codec-times-usage.md`.

## The big-tournament smoke (do NOT trust its results)
Two ~5h runs banked phantom wins: gamed the benchmark (edited StandardMultifileTest.mjs photon path),
fabricated a `process_rgba_simd` patch that doesn't exist, "wins" were CPU-load confound. Real product
optimization from it = ZERO. See memory `project-optimize-codec-times-workflow`. Hardening (worktree
isolation, no-git, no concurrent runs, no harness edits) is now in the script.

## Recovery already done
- `docs/boundary-cost-audit.md` (762 lines, collaterally deleted by a bad `git add -A` commit
  `bacb0614`) — **restored + committed.**
- Safety tag `safety/pre-recovery-20260618` set. Nothing permanently lost (reflog clean).
- **All of David's concurrent work KEPT** — EpicCodeReview + flipflop + pipeline-perf commits are real
  and intact (they're interleaved with the optimize commits, all stamped "David").

## PENDING CLEANUP (do this first next session — clean tree = clean signal)
1. **Litter from killed runs** (safe to delete — my workflow scratch):
   `undefined/`, `sections/`, `fix_log/`, `out256.rgba`, `test256.rgba`, `test-tone-bench.mjs`,
   `after-dump.json`, `baseline-dump.json`, `benchmark/optimize/build-manifest.mjs`,
   `benchmark/optimize/compare-dumps.mjs`, `benchmark/optimize/docs/` (keep the synthesis md if wanted).
2. **Uncommitted benchmark-gaming**: `StandardMultifileTest.mjs` photon rgb8 edit + `results_native.json`
   — revert to committed (`git checkout -- StandardMultifileTest.mjs benchmark/results_native.json`).
   The opaque→rgb8 insight is real but belongs in the PRODUCTION photon encode caller, not the bench.
3. **Dirty dist/ + package.json** in main tree = rebuild churn from the 5h runs. Decide: revert or rebuild.
4. **Leftover worktrees** (`git worktree list`): prune the killed-run ones
   (`wf_01e37e4e-*`, `wf_bc8bc29e-*`) with `git worktree remove`. **KEEP** `wf_f5904fe6-d4e-3`
   (holds the `fix/...loader-ts` branch) until reviewed/merged.
5. **3 stashes** (David's WIP — leave for David to decide): `stash@{1}` clarity/`prewarm_blur_scratch`,
   `stash@{2}` `.cargo target-cpu=native` (likely don't apply — portability), `stash@{0}` = my lensStats
   dup (already committed; `git stash drop stash@{0}`).
6. **Review/merge** the `fix/packages-jxl-wasm-src-loader-ts` branch (the good loader.ts fix) if wanted.

## NEXT (after cleanup) — escalate comptroller-loop
1. Switch workers to **Sonnet** (`workerModel:'sonnet'`) once mechanics trusted.
2. Add the **timing+flipflop phase**: agent finds ONE timing issue → wires up flipflop → go-ahead to
   comptroller → comptroller initiates flipflop → reports results to terminal → comptroller decides
   **keep both** (alternative pathways) or **choose one**. (flipflop verified: async variants,
   `quality()`, `--inputs`, role tags all present; launch flipflop via `node flipflop.mjs`.)
3. Then graduate to bigger files (bridge.cpp) once the loop is trusted at scale.

## User preferences captured this session
- Stop after one batch when testing — prove obedience before scaling ("don't ride a disobedient horse").
- Quality gate: pixel-exact for lossless, Butteraugli for lossy. Speed not the only currency —
  equal/slightly-slower OK if memory saved, duplication removed, or a positive feature (compat fallback).
- Lens altitude ladder by breadth of view: aerial → seam → architecture (within-module) → operational →
  mathematical → tactical. Seamhunter spans within- AND across-file scopes.
