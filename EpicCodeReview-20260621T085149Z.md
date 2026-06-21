# EpicCodeReview — `packages/jxl-scheduler/` — 2026-06-21

**Branch:** `EpicCodeReviewJxl-Scheduler`  **Commit:** `eb51ff6b`
**Mode:** workalone (Sonnet/Opus finders, parallel)  **Baseline → final tests:** 47/47 → **49/49 pass**

## Scope

| Section | Files | Reviewed |
|---------|-------|----------|
| `src/` | 7 (`scheduler.ts`, `pool.ts`, `queue.ts`, `dedupe.ts`, `budget.ts`, `types.ts`, `index.ts`) | ✅ full |
| `test/` | 10 | light (added 1 file) |
| `dist-test/` | 34 | ⏭ skipped — generated TS output of `src/` |

Three parallel finder agents (correctness, perf/hacker, structure) over `src/`. The package is
**mature and heavily pre-reviewed** — ~16 prior rounds visible as inline markers (S1–S16,
`logic-0002`, `errors-0004`, `concurrency-b2d7e3f1`, `sched-1`…). Findings were filtered hard
against "already documented as handled."

## Fixed & committed (`eb51ff6b`)

### 1. `abortAcquisition` synthesized the wrong terminal kind for encode subscribers — **issue, medium**
`scheduler.ts`. When a deduped primary aborts *before* worker assignment (destroyed / signal
aborted / cancelled during the admission-gate or spawn await), `abortAcquisition` notified every
fan-out subscriber with a hardcoded `decode_cancelled`. An **encode** subscriber's consumer waits
for an encode terminal and never recognizes `decode_cancelled` → hang. `shutdown()` and the
preempt-timeout path were already kind-aware; this path was decode-only.
**Fix:** derive `encode_cancelled` / `decode_cancelled` from the subscriber record's `kind`.

### 2. `DedupeRegistry.forEachSubscriber` allocated a snapshot array per message — **perf, hot path**
`dedupe.ts:153`. `register()` seeds the subscriber Set with the primary's own id, so a
non-deduped session always has `size === 1`. The old `for (const sub of [...subs])` therefore
allocated a throwaway 1-element array on **every** worker→main message (`handleWorkerMessage`
calls this for each metric/progress/chunk/terminal — the hottest dispatch path).
**Fix:** `size === 0` / `size === 1` fast paths that extract the single id without a snapshot,
preserving the delete-during-iteration safety the snapshot guards (a single post-iteration `fn`
call can't skip a "next" entry).
**Measured:** isolated A/B microbench (interleaved, 100M calls) → **60.2% faster** on that path
(2.51×). Gate ≥5% ✓. Parity: 49/49 tests pass, dedupe semantics unchanged.

### Test added
`test/scheduler.abort-dedupe.test.ts` — first coverage of the **AdmissionGate-blocked
acquisition** path: an encode subscriber on an aborted primary must get `encode_cancelled`; a
decode subscriber must still get `decode_cancelled`. Both pass.

## Deferred → `QUESTIONS.md` (5 items)

| # | Sev | Item | Why deferred |
|---|-----|------|--------------|
| Q1 | med | Subscriber record/`_subscriberCount` not cleaned on **normal** primary terminal (asymmetric vs abort path) | Depends on jxl-session's `completeSession`-per-subscriber contract — outside this package; a blind fix risks double-decrement |
| Q2 | low | `setPriority` has no `paused` branch + duplicates dedupe-escalation logic | Works by invariant; cleanup only |
| Q3 | low | `acquireSlot` returns `workerId: -1` sentinel vs `number\|null` | Public return-type change (no-go without caller audit) |
| Q4 | low | No input validation at public boundaries (`acquireSlot`/`setPriority` vs `CoreBudget` which validates) | Opportunity |
| Q5 | low | Reentrant `cancelSession` during `maxParkedSessions` eviction | Rare (default `Infinity`); doc/microtask defer |

## Deliberately not pursued
`signalDrain` queueDepth gauge (CLAUDE.md: A3 FALSIFIED, intentional) · pool/queue "dead" APIs
(test-support, `@internal`) · protocol-union `as`-casts (deliberate hot-path narrowing) ·
no layer violations found (backpressure / dedupe / budget all in their CLAUDE.md-mandated layers).

## Verdict
Two real fixes (one latent hang, one hot-path allocation) on otherwise solid, well-defended code.
No correctness-breaking bugs in the core state machine. Everything uncertain or API-shaped was
deferred rather than guessed.
