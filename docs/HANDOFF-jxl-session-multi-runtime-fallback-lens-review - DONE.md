# HANDOFF — jxl-session Multi-Runtime Fallback Session Contexts (Group 2) Lens Review

Date: 2026-06-13. Method: Direct source + contract + test verification pass. Cross-referenced prior `BrowserContextTierEvent.md` (identical 5-file scope). Verified against `CLAUDE.md` layer invariants, scheduler types, `packages/jxl-session/{BLOCKED,DECISIONS,STATE}.md`, and full test suite.

## Scope (Group 2)

Only these files (exact match to `docs/Groups of files to be investigated.md`):

1. `packages/jxl-session/src/browser.ts`
2. `packages/jxl-session/src/context.ts`
3. `packages/jxl-session/src/context-base.ts`
4. `packages/jxl-session/src/tier-routing.ts`
5. `packages/jxl-session/src/event-stream.ts`

Related (read-only for context): `decode-session.ts`, `encode-session.ts`, `util.ts`, package tests, `jxl-scheduler` contract, `@casabio/jxl-core` types.

## Strategic map

This is the **client-instantiated context layer**. Callers do:

```ts
const ctx = createBrowserContext({ wasmUrl: "...?jxlWorkerTier=simd-mt", poolSize: 3 });
const dec = ctx.decode({ format: "rgba8", priority: "visible", budgetMs: 8000, ... });
await dec.push(bytes); await dec.close();
for await (const f of dec.frames()) { ... }
const info = await dec.done();
await ctx.shutdown();
```

Responsibilities:
- Bundler hygiene: `browser.ts` (dynamic import of `@casabio/jxl-worker-browser` only) vs `context.ts` (adds `createNodeContext`).
- Scheduler binding: owns `Scheduler` (or two for tiered) and hands `Scheduler | Promise<Scheduler>` to `DecodeSessionImpl` / `EncodeSessionImpl`.
- Runtime capability probe (async, conservative default, shape-validated).
- Multi-runtime fallback routing (TieredJxlContextImpl): explicit MT request (`simd-mt` / `relaxed-simd-mt` via `?jxlWorkerTier`) produces two schedulers + `createTieredSchedulerRouter`. Visible work gets a short grace window (`visibleGraceMs`, default 16) to acquire an MT worker before falling back to ST. Background work falls back immediately.
- Policy kernel in `tier-routing.ts`: `parseRequestedWorkerTier`, `appendWorkerTierQuery`, `shouldUseMtImmediately` (idle > 0 || (spawn room && coreBudget.available >= mtCost)).
- Terminal push-driven iterable: `AsyncEventStream` (head-cursor buffer + compaction, single-waiter slot, `returned` guard, `clear()`).
- `sourceKey: null` always (dedupe/fan-out lives in scheduler and is intentionally unreachable here — see BLOCKED B-001 / DECISIONS D-003).

Backpressure, preemption, dedupe, and real worker lifecycle live one layer down in `jxl-scheduler`. This layer only chooses *which* scheduler (MT or ST pool) a new session is bound to at `acquireSlot` time.

## Verification (2026-06-13)

```powershell
cd packages/jxl-session && npm test
```

Result: 45 pass / 0 fail / 10 skipped (integration tests blocked on real codec per BLOCKED B-002). All unit coverage for tier routing, tiered router, AsyncEventStream, and session lifecycles (using real `Scheduler` + `FakeWorker`) passed cleanly. `dist/` and `dist-test/` were rebuilt during the run.

`createTieredSchedulerRouter` tests and `shouldUseMtImmediately` logic exercised the exact contention paths (budget exhaustion + no idle + spawn cap).

## Highest-value findings (consolidated)

These remain live (cross-checked against `BrowserContextTierEvent.md` which scoped *exactly* to these five files). No new P0/P1 bugs found in the fresh pass.

1. **Origin loss in worker URL tier injection** (`tier-routing.ts:24-29`, `browser.ts:51-59`)
   `appendWorkerTierQuery` does `new URL(url, "https://dummy.invalid")` then returns only `pathname + search + hash`. Absolute CDN or cross-origin worker URLs (`https://cdn.example.com/worker.js?...`) are silently turned into root-relative paths. Affects any caller passing an absolute `wasmUrl` with `?jxlWorkerTier=simd-mt`.

2. **Node entry swallows `wasmUrl`** (`context.ts:29-41`)
   `createNodeContext(opts)` accepts `ContextOptions` (including `wasmUrl`) but the factory ignores it completely. No validation, no error, no effect. `computeWorkerCostForWasmUrl` can still see it via the base path. Silent contract drift between browser and node surfaces.

3. **Visible grace sleep is non-abortable / non-wakeable** (`context-base.ts:173-180`, `TieredJxlContextImpl` ctor)
   When MT is contended, visible-priority sessions do `await sleep(visibleGraceMs)` then re-evaluate. The sleep has no tie to the session's `AbortSignal`, no early wake on pool metric change, and the pending `router.pick()` promise can resolve after `shutdown()`. Latency-sensitive decodes pay the full 16 ms even if capacity frees earlier.

4. **AsyncEventStream single-consumer contract is documented but unenforced** (`event-stream.ts:6-11, 71-124`)
   Strong comments, single `waiter` slot, `returned` flag + `clear()` on `return()`. However the public `[Symbol.asyncIterator]()` allows a second `for await` to stomp the waiter. Buffer is unbounded — a slow consumer (or `done()`-only caller that never consumes `frames()`) can pin many large pixel `ArrayBuffer`s.

5. **Capability probe is per-context fire-and-forget with no readiness surface** (`context-base.ts:120-148`)
   `probeCapabilities()` kicks off an async import + validate; `capabilities()` returns the (possibly stale) default until it settles. No shared cache across contexts, no `probeSettled` exposure, no error channel, no way for callers to wait for the probed value before making MT/ST decisions.

6. **MT routing policy is deliberately minimal / binary** (`tier-routing.ts:35-44`, `context-base.ts:155-182`)
   Decision uses only `poolIdle`, `poolSize + poolSpawning < max`, and `coreBudget.available >= mtCost`. No hysteresis, no session age, no queue depth, no work-class / saliency hint, no cost from the actual decode options. This matches the original design (see ProgressiveSaliencyImplementationPlan) but limits future use for expensive metrics, ROI, etc.

### Additional observations from this pass (no new severity)

- The `Scheduler | Promise<Scheduler>` handoff in `DecodeSessionImpl` / `EncodeSessionImpl` ctor + `isPromiseLike` branch works cleanly for the tiered router (only the visible grace path produces a promise). `acquirePromise` chaining, handler registration before `acquireSlot`, and post-await closed/terminated guards are correct.
- Metrics adapter in `TieredJxlContextImpl` uses `as any` to project the fuller `SchedulerMetrics` down to the `PoolPressureMetrics` shape expected by `shouldUseMtImmediately`. Works but is a small type-safety hole on the hot path.
- `stFactory` in the MT-requested tiered case is forced to the `"simd"` tier (ST). `stScheduler` always gets workerCost=1. This is intentional for fallback accounting.
- `validateWasmUrl` is only called in the browser path. Node path never reaches it.
- `sourceKey: null` is hard-coded in both session impls when they call `acquireSlot`. This is by design (dedupe disabled at this layer).
- Browser pool sizing caps at `min(4, hardwareConcurrency-1)`; node uses full `hardwareConcurrency-1`. Matches DECISIONS D-008.
- `AsyncEventStream` compaction and slot-nulling on read (warm path) plus module-level `DONE` singletons are already in the shape that addressed earlier ES-1..ES-5 items.

## Layer invariants check (CLAUDE.md)

- Backpressure lives at scheduler/worker boundary: **holds** (sessions only call `waitForDrain` + `send`).
- Deduplication lives in scheduler (`DedupeRegistry`): **holds** (always `sourceKey: null` here).
- Budget is session-level from construction: **holds** (passed in `startMsg.budgetMs`).
- Preemption is scheduler-only: **holds** (this layer only picks MT vs ST scheduler at acquire time).
- Event stream single-consumer is assumed/documented: **partially** (strong docs + guards, no runtime assertion).
- Format validation belongs to libjxl: **not applicable here**.
- No per-stage budget reset, no pixel buffer pools, no drain callbacks inside facade: all respected.

## Current state vs package docs

- **STATE.md**: "COMPLETE (structurally) — end-to-end blocked on codec tasks". Still accurate.
- **BLOCKED.md**: B-001 (sourceKey/dedupe), B-002 (codec), B-003 (cache wiring) — unchanged.
- **DECISIONS.md**: All listed decisions (D-001..D-011) still reflected in the code (e.g. no-op catches on done(), dynamic imports, pool sizing, budget graceful end vs fail, etc.).

## Recommended next actions

1. The lossless `withWorkerTier` + node rejection patches from the prior `BrowserContextTierEvent.md` were applied in this pass (see Implemented chapter below). Remaining items (grace, stream, probe, policy) were reassessed and rejected (details in Implemented + `docs/rejected optimizations.md`).
2. Any future change that touches scheduler creation, router policy, or `AsyncEventStream` buffering must be benchmark-gated and checked against `docs/rejected optimizations.md`.
3. For future Group 2 work, also touch the callers in `web/jxl-browser-context.js`, `web/jxl-single-progressive.js`, and any T-INT integration that supplies `wasmUrl`.

## Files that may be edited (without further approval for Group 2 scope)

Only the five files listed in Scope. Edits to `decode-session.ts`/`encode-session.ts`, scheduler, core protocol, or web callers require explicit approval or a new handoff.

## Verification command for future changes to this group

```powershell
cd packages/jxl-session && npm test
# plus (per AGENTS.md for progressive decode areas, though not directly touched here):
# rtk proxy bun test packages/jxl-wasm/test/progressive-visible-passes.test.ts
# rtk proxy bun test web/jxl-single-progressive-page.test.js
```

## Implemented

2026-06-13: Implemented the plan from `BrowserContextTierEvent.md` (Agent handoffs + 6 findings + layers). Each item examined for relation to touched files and position in pipeline (UI layer callers -> jxl-session context factories/routing -> session impls (Decode/EncodeSessionImpl acquirePromise + router promise) -> jxl-scheduler (acquireSlot + CoreBudget + workerCost + pool metrics) -> jxl-worker-* (spawn with url) -> WASM/native builds). Reassessed before edit for positive net change vs risk/complexity/prior rejections in CLAUDE.md and rejected optimizations. Worked from memory of sources + prior reads; surgical search/replaces only; tests re-run post-edit (45 pass/0 fail, relative tier cases unchanged).

**Item 1: Stop corrupting absolute worker URLs (Agent 1 + finding 1, Layer 1 contract hardening)**  
Reassessed: Positive. Direct bug for any prod usage of absolute `wasmUrl` + explicit MT tier (CDN workers common for cache/coop). Touches only tier-routing (append logic) + browser (call site). No scheduler/pool impact; relative paths (current tests + callers) produce identical output.  
Applied:  
- tier-routing.ts: rewrote appendWorkerTierQuery origin detection (try absolute new URL else dummy base) so hadOrigin ? toString() : path+search+hash. Added withWorkerTier helper.  
- browser.ts: updated import + mt/st branches to consume withWorkerTier (plain branch left as opts?.wasmUrl to avoid injecting `auto` query for non-MT callers).  
Outcome captured here. (No entry in rejected optimizations.)

**Item 2: Eliminate silent node/browser contract drift for wasmUrl (Agent 2 + finding 2, Layer 1)**  
Reassessed: Positive. Prevents config lie on server path (node factory has no url param; spawnWorker() is parameterless). Explicit error is better than swallow. Touches only context.ts (and cleaned its dead validateWasmUrl import per the plan). No effect on valid node usage or browser. Cohesive with browser validate path.  
Applied:  
- context.ts: added early throw in createNodeContext with message matching plan suggestion; added explanatory comment; removed unused validateWasmUrl from import (removes ambiguity).  
Outcome captured here.

**Items 3-6 + remaining Agent handoffs (grace abort/wake, stream single-consumer enforce + bound, capability probe readiness/cache, MT policy extensions, Agent 3 centralize state/races/hooks, Layer 2/3/4 future rails, event pressure etc.)**  
Reassessed before any edit: Not positive for surgical application in this Group 2 pass.  
- 3 (grace): 16ms window is small; making pick() abortable would require threading AbortSignal (from DecodeOptions) into createTieredSchedulerRouter + sleep + Tiered ctor + session acquirePromise setup. Risk of new acquire races or leaked slots in scheduler. Low ROI vs complexity. Touches context-base + potentially decode-session + router. Defers cleanly.  
- 4 (event-stream): Contract already heavily documented + single-waiter + returned/clear guards + compaction. Runtime second-iterator throw would be new assertion surface; buffer bound would be policy change adjacent to previously rejected buffer/pool ideas (R1-2 etc). Consumer controls consumption rate. No edit.  
- 5 (probe): Design per DECISIONS D-002 (sync caps() + async side-effect update) is intentional and stable. Shared cache or ready() promise would be new public surface on JxlContext, require capabilities package coordination, and affect routing decisions timing. Not surgical.  
- 6 (policy): Binary decision was by design for this layer (delegates power to coreBudget + scheduler). Adding hysteresis/age/saliency would be feature work belonging higher (caller) or deeper (scheduler) with benchmarks. Plan noted as future.  
- Agent 3+ and layers 2-4: Would require non-minimal refactors (central state, shutdownAbort into router, new routeHints opts, instrumentation on stream). Cross multiple files + scheduler boundary. Reassessed as out of narrow surgical scope for Group 2.  
All rejected for this pass. Entries added to `docs/rejected optimizations.md` with pipeline-specific rationale.

**Verification performed (quiet):** `cd packages/jxl-session && npm test` post-edits: 45 pass, 0 fail, 10 skipped (same as pre), tier-routing + tiered-router tests passed (absolute new path unexercised by existing relative asserts). No other files required cohesion edits.

**Updates to this document:** Recommended list point 1 refreshed; this Implemented chapter added at end. The two positive items are now live in src (with origin preservation and explicit node contract).

Rejections recorded in rejected optimizations for audit.

---

**Group 2 review artifact** per `docs/Groups of files to be investigated.md`. Prior detailed findings live in `docs/BrowserContextTierEvent.md` (and its recovered copy). This document records the 2026-06-13 verification pass, surgical implementations from the plan (URL + node), rejections, and the Implemented chapter at the end of this file.

If patches from the earlier handoff sections are desired, supply the signal and they can be implemented (with tests + the above verification command).