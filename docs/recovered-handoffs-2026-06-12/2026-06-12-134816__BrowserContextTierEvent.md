# Progressive Saliency Implementation Plan

## Scope

Only these files in scope:

- `packages/jxl-session/src/browser.ts`
- `packages/jxl-session/src/context.ts`
- `packages/jxl-session/src/context-base.ts`
- `packages/jxl-session/src/tier-routing.ts`
- `packages/jxl-session/src/event-stream.ts`

## System Map

`browser.ts` is browser public facade. It validates browser-only `wasmUrl`, chooses worker tier from URL query, builds worker factories, then instantiates either `JxlContextImpl` or `TieredJxlContextImpl` and starts async capability probe. `context.ts` is non-browser facade. It re-exports browser entry and defines node entry, but today node path silently ignores `opts.wasmUrl`.

`context-base.ts` is orchestration core. It defines public `JxlContext` API, default capability snapshot, capability probe, scheduler creation, worker-cost derivation, and tiered routing grace logic. `tier-routing.ts` is tiny policy kernel: parse requested worker tier, append tier query to worker URL, decide if MT can start now. `event-stream.ts` is UI-facing reactive pipe: worker/session events enter through `push()`, consumers drain through single async iterator semantics that are documented but not enforced.

## Highest-Value Findings

1. `appendWorkerTierQuery()` drops absolute URL origin by returning `pathname + search + hash` only. Browser entry uses this value for worker spawn URL, so CDN/alternate-origin worker URLs can be corrupted and tier choice can silently degrade. `packages/jxl-session/src/tier-routing.ts:24-29`, `packages/jxl-session/src/browser.ts:52-55`
2. `createNodeContext()` ignores `opts.wasmUrl` entirely. Caller can believe custom worker asset path is active when it is not. Either reject this option in node entry or plumb it through explicitly. `packages/jxl-session/src/context.ts:29-39`
3. Tiered visible routing sleeps fixed grace without cancellation or wake-on-capacity. Shutdown/cancel race can return scheduler after shutdown; latency-sensitive visible work pays full grace even if MT becomes free earlier. `packages/jxl-session/src/context-base.ts:155-181`, `packages/jxl-session/src/context-base.ts:262-265`
4. `AsyncEventStream` documents single-consumer contract but does not enforce it. Second iterator can trample waiter state. Also buffer is unbounded, so slow UI consumer can accumulate stale metrics/frames. `packages/jxl-session/src/event-stream.ts:6-11`, `packages/jxl-session/src/event-stream.ts:18-42`, `packages/jxl-session/src/event-stream.ts:103-106`
5. Capability probe is duplicated per context and only exposes eventual side effect through `capabilities()`. No shared probe cache, no readiness surface, no typed probe state. This wastes startup work and weakens observability for routing/UI decisions. `packages/jxl-session/src/context-base.ts:120-148`
6. MT routing policy is too binary. It sees idle/spawn/budget only; it has no hysteresis, no queue-age awareness, no work-class hint, no saliency/latency channel. That blocks future wins for Butteraugli, AR recognition, photogrammetry, and progressive ROI pipelines. `packages/jxl-session/src/tier-routing.ts:35-44`, `packages/jxl-session/src/context-base.ts:155-181`

## Lens Fusion

### Strategic linkage

- Public entry points pass `ContextOptions` inward, derive worker tier from `wasmUrl`, then hand decode/encode sessions to scheduler-backed contexts.
- Shared context passes only scheduler choice and default capabilities downstream; no explicit pipeline-stage or work-class metadata survives routing.
- Event stream is terminal visibility point back to UI, but today lacks built-in coalescing, queue telemetry, or semantic channels for recognition/saliency overlays.

### Public API / boundary points

- Browser API surface is broad because `browser.ts` re-exports sessions and stream type, not only factory. Good for ergonomics, but more fragile when semantics change.
- Node and browser entry points do not present identical option behavior. Same type, different runtime contract.
- JS↔WASM boundary is indirect here: these files decide worker asset, scheduler count, and event cadence. Small bugs here multiply inside heavy decode/metric kernels.

### State machinery

- Context state: `caps`, `shuttingDown`, `probeSettled`. Missing: probe promise, shutdown abort signal, routing generation/epoch.
- Queue state: scheduler metrics exist, event-stream buffer exists, but neither exposes boundedness/health signals.
- Cancellation state: no cancel-aware grace wait; `return()` in stream is global and terminal.
- Error state: capabilities tamper fallback is silent; node ignored option is silent; stream fail drops buffered partial state by design.

### Data structures / hot paths

- URL parsing duplicated across files and repeated on hot context construction.
- Router metrics are projected through `as any`, weakening type safety on hot scheduling path.
- Event buffer uses O(1) head cursor and compaction. Good. Missing: bounded policy, replacement policy, multi-class buffering.

### Support / tests / observability

- No runtime assertions for single-consumer misuse.
- No telemetry for route decisions, grace sleeps, dropped/coalesced events, capability probe source.
- Tests should target: absolute URL preservation, node option rejection, shutdown-vs-grace race, multi-consumer rejection, slow-consumer bounded buffering.

## Reversal Lens: Run Film Backwards

1. If user reports "custom worker URL works locally, fails in production CDN", walk backward to `appendWorkerTierQuery()` origin loss.
2. If user reports "visible progressive decode randomly stalls 16ms under load", walk backward to fixed grace sleep with no wake-on-capacity.
3. If user reports "memory climbs during progressive preview/telemetry", walk backward to unbounded `AsyncEventStream` buffering of stale events.
4. If user reports "server config accepts wasmUrl but behavior unchanged", walk backward to node entry swallowing option without validation.

## Future Hooks Worth Enabling In These Layers

These files cannot speed pixel math directly, but they can make future kernels much faster and safer by carrying intent:

- Telescope pattern: fast coarse scan first, then high-resolution reacquire. Route `visible` saliency/preview work to fastest-available lane, defer expensive fidelity/metric jobs to background lane.
- Gaming pattern: frame budget, level-of-detail, dirty-region cadence, stale-event coalescing, priority aging.
- LLM/recognition pattern: event stream should optionally carry ROI boxes, tile ids, confidence, pose/color-constancy metadata without flooding UI.
- Photogrammetry / digital-twin pattern: contexts and streams should understand long-lived session identity, viewpoint sequence, and tile/region saliency hints.
- Butteraugli pattern: routing layer needs future `costHint` / `workClass` support so very expensive quality metrics do not steal visible decode budget.
- Perceptual-constancy pattern: context/routing/event layers should be ready to propagate color-engine mode flags and saliency-triggered recompute events without opening new side channels later.

## Biggest Gaps Still Unlit

1. How `DecodeSessionImpl` and `EncodeSessionImpl` consume promised schedulers, cancellations, and event streams. Biggest hidden risk because these five files hand control into them.
2. Actual worker message protocol shape. Needed to design event coalescing without losing semantically distinct progress markers.
3. Where expensive metrics like Butteraugli are scheduled today. These files can reserve hooks, but true gains depend on upstream caller metadata and downstream worker behavior.

## Implementation Layers

### Layer 1: Contract hardening

- Make worker URL normalization single-source and lossless.
- Align browser/node option semantics.
- Turn silent misuse into explicit runtime error or explicit supported path.

### Layer 2: Smarter scheduler routing

- Move from binary MT-now/ST-now choice to typed routing inputs with grace, hysteresis, and future cost hints.
- Make grace sleep abortable and observable.
- Cache capability probe result and expose stable readiness semantics.

### Layer 3: Event pressure control

- Enforce single-consumer contract at runtime.
- Bound or coalesce stale event classes.
- Emit instrumentation for dropped/coalesced/backed-up events.

### Layer 4: Future feature rails

- Add optional metadata seams for saliency, ROI, recognition, photogrammetry, perceptual-constancy mode, and expensive metric work-classing.
- Keep defaults no-op so existing callers keep current behavior.

---

## Agent 1 Handoff: `packages/jxl-session/src/browser.ts`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

### Goals

- Stop corrupting absolute worker URLs after tier injection.
- Reduce browser entry duplication with routing helpers.
- Prepare browser entry for future saliency/latency routing knobs without widening default API too much.

### Changes

1. Consume a lossless URL-normalization helper from `tier-routing.ts` instead of manually combining `parseRequestedWorkerTier()` and `appendWorkerTierQuery()`.
2. Preserve absolute origins for CDN or alternate-origin worker assets.
3. Add optional browser-only routing overrides passthrough if shared context exposes them later, such as `visibleGraceMs` or future `routeHints`. Keep defaults unchanged.
4. Keep browser default pool cap, but document why cap exists and route MT-vs-ST through normalized tier result, not repeated string checks.

### Suggested snippet

```ts
const requestedTier = parseRequestedWorkerTier(opts?.wasmUrl);
const mtUrl = withWorkerTier(opts?.wasmUrl, requestedTier);
const stUrl = withWorkerTier(opts?.wasmUrl, "simd");

const ctx = isMtRequestedTier(requestedTier)
  ? new TieredJxlContextImpl({
      mtFactory: factoryForUrl(mtUrl),
      stFactory: factoryForUrl(stUrl),
      opts,
      maxWorkers: poolSize,
    })
  : new JxlContextImpl(factoryForUrl(withWorkerTier(opts?.wasmUrl, requestedTier)), opts, poolSize);
```

### Acceptance

- Absolute `https://cdn.example.com/worker.js?x=1` stays absolute after tier injection.
- Relative `/worker.js` stays relative.
- Browser entry still lazily imports `@casabio/jxl-worker-browser`.

---

## Agent 2 Handoff: `packages/jxl-session/src/context.ts`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

### Goals

- Eliminate silent node/browser contract drift.
- Make unsupported node options explicit.
- Keep entry-point semantics obvious for future server-side batch, recognition, and metric workloads.

### Changes

1. Decide one contract for `opts.wasmUrl` in node:
   - safer now: reject it explicitly because current node worker factory ignores it, or
   - if node worker already supports asset override, plumb it through here.
2. Remove dead import path ambiguity. `validateWasmUrl` is imported but unused; either use it as precondition or drop it after explicit node rejection path.
3. Add short comment that browser and node share `ContextOptions` type but not necessarily every option implementation, until parity exists.
4. Reserve one explicit extension seam for future node routing hints if server-side queues need different treatment than browser-visible workloads.

### Suggested snippet

```ts
if (opts?.wasmUrl !== undefined) {
  throw new Error(
    "[jxl-session] createNodeContext() does not support wasmUrl yet; node worker resolution is controlled by @casabio/jxl-worker-node",
  );
}
```

### Acceptance

- Node callers no longer get silent no-op config.
- Public API behavior is explicit and testable.

---

## Agent 3 Handoff: `packages/jxl-session/src/context-base.ts`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

### Goals

- Centralize capability/routing state.
- Remove shutdown-vs-grace races.
- Add hooks for future cost-aware scheduling without changing default visible behavior.

### Changes

1. Cache capability probe promise at module scope or static scope so multiple contexts do not repeat import/probe work.
2. Add explicit probe state surface internally: `probePromise`, `probeSettled`, optional `lastProbeSource`. Keep public `capabilities()` fast.
3. Make tiered router sleep abortable. `shutdown()` should abort pending grace waits before schedulers shut down.
4. Replace `as any` metrics projection with typed helper function.
5. Unify worker-target normalization with helper from `tier-routing.ts` so worker cost and requested tier derive from same parser.
6. Prepare router input type for future `costHint` / `workClass` / `saliency` metadata even if decode/encode still default to current priority mapping.
7. Tighten `validateWasmUrl()` for secure-context mismatch if feasible:
   - reject `http://` when current page is secure, or
   - at least document and log mixed-content risk near validation.

### Suggested snippets

```ts
let capabilityProbePromise: Promise<Capabilities | null> | null = null;

function probeCapabilitiesOnce(): Promise<Capabilities | null> {
  if (capabilityProbePromise) return capabilityProbePromise;
  capabilityProbePromise = (async () => {
    try {
      const mod = await import("@casabio/jxl-capabilities");
      return validateCapabilities(await mod.getCapabilities());
    } catch {
      return null;
    }
  })();
  return capabilityProbePromise;
}
```

```ts
function schedulerPoolMetrics(scheduler: Scheduler): PoolPressureMetrics {
  const metrics = scheduler.getMetrics() as {
    poolIdle: number;
    poolSize: number;
    poolSpawning: number;
  };
  return {
    poolIdle: metrics.poolIdle,
    poolSize: metrics.poolSize,
    poolSpawning: metrics.poolSpawning,
  };
}
```

```ts
const shutdownAbort = new AbortController();
// pass shutdownAbort.signal into createTieredSchedulerRouter(...)
// shutdown(): shutdownAbort.abort(); then scheduler shutdown
```

### Acceptance

- Shutdown during visible grace cannot later route new work onto dying scheduler.
- Capability probe work is amortized across contexts.
- Routing policy becomes single-source for tier, cost, and future work-class metadata.

---

## Agent 4 Handoff: `packages/jxl-session/src/tier-routing.ts`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

### Goals

- Make worker-target parsing lossless and reusable.
- Upgrade routing from string helpers into typed policy kernel.
- Open path for Butteraugli/background-analysis separation without touching heavy kernels yet.

### Changes

1. Fix `appendWorkerTierQuery()` so absolute URLs preserve origin; relative URLs remain relative.
2. Add one normalized helper object. Example fields:
   - `requestedTier`
   - `resolvedUrl`
   - `workerCost`
   - `mtRequested`
3. Keep `parseRequestedWorkerTier()` cheap, but make other files consume normalized result instead of reparsing URL separately.
4. Extend routing policy shape for future inputs:
   - `queueAgeMs`
   - `workClass` such as `visible`, `background`, `metric`, `recognition`
   - `saliencyBoost`
   - `graceDeadlineMs`
5. Add hysteresis helper or aging helper so visible work does not flap MT/ST when pool pressure oscillates at threshold.

### Suggested snippet

```ts
const DUMMY_BASE = "https://dummy.invalid";
const DUMMY_ORIGIN = new URL(DUMMY_BASE).origin;

export function appendWorkerTierQuery(url: string | undefined, tier: RequestedWorkerTier): string | undefined {
  if (url === undefined) return undefined;
  const parsed = new URL(url, DUMMY_BASE);
  parsed.searchParams.set(TIER_QUERY_KEY, tier);
  return parsed.origin === DUMMY_ORIGIN
    ? `${parsed.pathname}${parsed.search}${parsed.hash}`
    : parsed.toString();
}
```

### Acceptance

- Single source of truth for worker tier, URL, and MT cost.
- Routing helper ready for future low-latency saliency and slow-metric segregation.

---

## Agent 5 Handoff: `packages/jxl-session/src/event-stream.ts`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

### Goals

- Enforce contract already documented.
- Prevent UI lag and memory growth under slow consumers.
- Create event rail suitable for progressive saliency, recognition, AR, and photogrammetry overlays.

### Changes

1. Enforce single-consumer contract at runtime. Reject second active iterator immediately with explicit error.
2. Add bounded buffering policy. Minimum acceptable version:
   - configurable `maxBuffered`
   - default conservative value
   - drop oldest or coalesce stale events when full
3. Add optional coalescing hook for high-rate metric/progress events so newest state wins when consumer is behind.
4. Track lightweight diagnostics internally:
   - `bufferedCount`
   - `droppedCount`
   - `coalescedCount`
   - `peakBuffered`
5. Preserve current fast path for warm reads and zero-allocation done path.
6. Ensure `return()` clears active-consumer guard so later replacement consumer can attach only if that behavior is desired; otherwise explicitly make stream permanently closed and document it at runtime too.
7. Add explicit `throw()` if needed so consumer exception path is deterministic.

### Suggested snippet

```ts
private activeConsumer = false;

[Symbol.asyncIterator](): AsyncIterator<T> {
  if (this.activeConsumer) {
    throw new Error("[jxl-session] AsyncEventStream supports only one active consumer");
  }
  this.activeConsumer = true;
  return {
    next: () => { /* keep current fast path */ },
    return: () => {
      this.activeConsumer = false;
      this.returned = true;
      this.clear();
      const w = this.waiter;
      if (w !== null) { this.waiter = null; w.resolve(DONE as IteratorResult<T>); }
      return DONE_PROMISE as Promise<IteratorResult<T>>;
    },
  };
}
```

### Acceptance

- Misuse becomes visible immediately.
- Slow UI consumer no longer causes unbounded growth.
- Stream can carry future saliency/recognition/pose events without flooding renderer.

Last agent: after all accepted work lands, append `- DONE` to filename.

## Overview

Implementing this plan makes session orchestration more trustworthy under real load. Worker-tier selection becomes lossless and explicit, node/browser contracts stop drifting silently, and shutdown/routing races stop leaking latency or work into dead schedulers. That raises correctness first, then unlocks measurable speed by reducing misroutes, duplicate capability probes, and unnecessary grace delays.

Second, event delivery becomes fit for high-frequency progressive UX instead of best-effort buffering. Bounded/coalesced streams plus typed routing hints give room for progressive saliency, ROI-first preview, Butteraugli deferral, recognition overlays, photogrammetry session metadata, and future perceptual-constancy toggles. These files still are not pixel kernels, but they become right control plane for faster kernels, smarter prioritization, and much better observability.
