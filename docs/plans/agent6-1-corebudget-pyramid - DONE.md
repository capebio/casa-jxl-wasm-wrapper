# Plan: Agent 6 Item 1 — Wire pyramid pool into CoreBudget (Lens 1/19)

**Status**: One-page plan. No source edits. Approval required before any change.

## Goal
Prevent core oversubscription when jxl-scheduler (progressive sessions) and jxl-pyramid (tiled viewport decodes) run concurrently by making PyramidWorkerPool optionally participate in the shared CoreBudget semaphore.

## Merit (pipeline context)
- Real risk: scheduler pool (MT workers cost N cores via acquireWithFallback) + pyramid pool (min(HWC,8) warm workers for tiles) can exceed hardwareConcurrency.
- CoreBudget + globalCoreBudget already exist (budget.ts, honoured in pool.ts + scheduler.ts + jxl-session/context-base.ts).
- Pyramid tiled-decode-pool.ts + decode-core.ts explicitly call out the separation: "Cross-pool CPU/core oversubscription is governed by CoreBudget (sched-1) on the scheduler side only. No unification of the two pools is planned in the current architecture; they remain distinct by design." (decode-core.ts:374-382).
- EpicCodeReview-jxl-pyramid and handoffs repeatedly note "jxl-pyramid pool is a SECOND worker pool".
- Positive contribution: bounded total WASM thread load on mixed progressive + lightbox/pan workloads. Matches sched-1 intent.

## Constraints / invariants (do not violate)
- CLAUDE.md: before touching scheduler/pool, confirm layer, check rejected optimizations.md. (This is pyramid pool, not scheduler pool; no prior exact rejection for budget wiring.)
- decode-core.ts comment above is load-bearing architecture signal — plan must update or supersede it.
- Pyramid pool is "dumb tile protocol" (load once by bytesId + per-tile decode ROI); stateless per tile. Scheduler pool is full session state machine. Keep distinction.
- Acquire/release must be around the actual parallel work (decodeTilesParallel or the liveHandles window), not per tile (to avoid token thrash).
- Worker cost model: pyramid tiles are typically lighter than full MT session; start with cost=1 per live handle (or configurable). Use tryAcquire or acquireWithFallback?
- Existing PyramidPoolLike duck type, getOrCreatePool singleton, explicit opts.pool, web/lightbox/tiled-decode-worker.js callers.
- No change to scheduler backpressure, DedupeRegistry, pause/resume.
- rejected optimizations.md: broad pyramid refactors (Zod, full observability, ctor groups) were rejected; keep this surgical (optional coreBudget only).

## Files / cross-file surface (why outside "three files")
- packages/jxl-pyramid/src/tiled-decode-pool.ts (main acquire/release + ctor)
- packages/jxl-pyramid/src/decode-core.ts (PyramidPoolLike, DecodeOptions, comment update, perhaps export type)
- packages/jxl-scheduler/src/budget.ts (or re-export; optional import)
- Call sites: web/lightbox/* (tiled decode init), any direct pyramid consumers, tests in jxl-pyramid/test/
- Possibly jxl-pyramid/src/index.ts barrel
- (Optional) light touch in pyramid-ingest if manifest grows, but out of scope.

## One-page sketch (minimal steps)
1. Add optional `coreBudget?: CoreBudget` (default null) + `workerCost?: number` (default 1) to PyramidWorkerPool ctor and PyramidPoolLike. WorkerCost per handle (tile work is lighter than full MT session).
2. **Efficiency:** In acquire (around liveHandles = await p.acquire), first try `coreBudget.tryAcquire(cost * desired)` non-blocking. On shortfall use acquireWithFallback( cost ) or partial grant + fallback to 1 for some handles. This keeps hot pan path (already async) from extra queuing when tokens free. Integrate with pyramid's existing waiter queue (LIFO idle, armExcess) so budget waiters don't create second FIFO.
3. In finally release(liveHandles): coreBudget.release(actualGranted) for exactly the handles that consumed tokens. Release even on partial failure.
4. Wire through decodeTiledViewportPooled + DecodeOptions (add coreBudget?: CoreBudget). Callers that already pass explicit pool can pass budget too; default singleton path can opt-in to globalCoreBudget (document the choice).
5. Update the load-bearing comment at decode-core.ts:374 (and plan.ts if it mentions pools) to "opt-in cross-pool budgeting via CoreBudget for sched-1 + pyramid tile workers; pools remain distinct (dumb ROI vs full session)".
6. In getOrCreatePool: only attach budget if caller supplies or explicit opt-in flag; never silently bind global for the module singleton (prevents surprise contention).
7. Add test: capacity=2 budget; one scheduler MT worker + one pyramid batch acquire(desired=3) → verify fallback or wait + release accounting. Exercise dc vs final (same cost).
8. Update JSDoc/DECISIONS.md lightly. No worker protocol change (budget lives in main-thread pool acquire only).
9. Optional fast feature (cheap): on acquire, if progressiveStage==='dc' allow lower effective cost (or just document that dc tiles are lighter and finish faster, releasing sooner).

## Efficiency & Speed deltas
- tryAcquire first + acquireWithFallback reuses CoreBudget's existing ST fallback logic (no new waiter types).
- Token scope is "per live handle for the batch window", matching pyramid's acquire(desired)/release(handles) already — zero per-tile tax.
- No impact on scheduler Dedupe/HWM/backpressure.

## Verification (narrow first)
- `bun test packages/jxl-pyramid/test/decode-pool.worker.integration.test.ts` (and other pyramid tests)
- Existing scheduler budget tests still pass (they import globalCoreBudget).
- Manual: open lightbox on large tiled JXL while running concurrent progressive sessions; observe no >HWC workers via devtools / added counter if needed.
- Build: `cd packages/jxl-pyramid && bun run build` + full workspace typecheck.
- If web/ uses it: spot-check gallery/lightbox pan under load.
- Run any rtk/bun test commands referenced in Agents.md for pyramid-adjacent if they exist.

## Risks / open questions
- Token cost model for a "tile batch handle" — 1 may under-throttle or over-throttle vs full session MT. Start with 1; add optional per-handle cost override later if data shows need.
- Singleton default pool + globalCoreBudget: who owns the budget instance? Prefer explicit injection from callers (jxl-session style).
- Performance: extra await on hot pan path (already async acquire). tryAcquire fastpath mitigates the common case.
- If rejected in past as "two pools by design", this is the deliberate first unification point — document in plan/ADR note. Update decode-core.ts comment.
- Unknown: current real-world concurrency of scheduler + pyramid in same page? Add a cheap counter in a follow-up if needed.

**Approval gate**: User must say "approved, execute 1" (or all) before any search_replace or edit. Plans only.
