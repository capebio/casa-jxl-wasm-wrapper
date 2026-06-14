# Handoff: nosharp pipeline hangs under MT encoder tier

**Owner**: Grok (next task)
**Reviewer**: David
**Date opened**: 2026-06-07
**Base branch**: `feat/fast-jpeg`
**Related**: `docs/Grok-Handoff-FastJpeg.md`

---

## Goal

Diagnose and fix the worker / pthread leak that causes `inbetween-no-sharp.mjs` (and the `nosharp` pipeline in `bench-suite.mjs`) to hang when the JXL encoder tier is `relaxed-simd-mt` (or any MT tier) in Node.

This is **not** a fast-jpeg problem. fast-jpeg's bench (`BENCH_PIPELINES=sharp,fastjpeg`) runs to completion under MT in ~20s. The same harness with `BENCH_PIPELINES=nosharp` hangs partway through the second file (~14/63 runs done in 10 min, then no progress).

## Reproduction

From `timings/fastest/`:

```powershell
# Hangs partway through (do not wait — kill node after ~3 min)
node bench-suite.mjs

# Or directly target nosharp under MT
$env:BENCH_PIPELINES = "nosharp"
node bench-suite.mjs
```

The script installs a `BrowserLikeWorker` shim (lines 6–28 of `bench-suite.mjs`) so libjxl's pthread pool can spin up in Node. Auto-detected tier becomes `relaxed-simd-mt`. Sharp + fastjpeg pipelines run to completion under that tier. nosharp does not.

Forcing `setForcedTier('simd')` (no MT) restores nosharp to a working state (see Result 1 in `Grok-Handoff-FastJpeg.md` — nosharp totals 8049ms across the fixture under simd, completes cleanly).

## Symptom

Log progresses normally for one file (~9 runs across all three pipelines). On the second file's nosharp runs, output stops appearing. `tasklist` shows multiple `node.exe` workers persisting. CPU drops to near zero. Process never exits.

Sample log (truncated after stall):

```
=== P2200476 Pogonospermum cleomoides.ORF ===
Embedded JPEG: 957566 bytes (3200x2400)
  sharp    run 1: decode= 157.4ms encode= 567.5ms total= 724.9ms ...
  sharp    run 2: decode= 152.2ms encode= 116.8ms total= 269.0ms ...
  sharp    run 3: decode= 168.3ms encode= 109.9ms total= 278.2ms ...
  nosharp  run 1: decode= 639.7ms encode= 117.8ms total= 757.5ms ...
  nosharp  run 2: decode= 395.9ms encode= 128.8ms total= 524.7ms ...
  nosharp  run 3: decode= 445.8ms encode= 138.5ms total= 584.3ms ...
  fastjpeg run 1: decode= 236.4ms encode= 132.3ms total= 368.6ms ...
  fastjpeg run 2: decode= 151.0ms encode= 126.3ms total= 277.2ms ...
  fastjpeg run 3: decode= 151.4ms encode= 133.4ms total= 284.7ms ...

=== P2200564.ORF ===
Embedded JPEG: 1043811 bytes (3200x2400)
  sharp    run 1: decode= 174.4ms encode=  98.3ms total= 272.7ms ...
  sharp    run 2: decode= 172.3ms encode=  85.7ms total= 257.9ms ...
  sharp    run 3: decode= 173.5ms encode=  88.5ms total= 262.0ms ...
  nosharp  run 1: decode= 532.9ms encode=  79.8ms total= 612.7ms ...
  nosharp  run 2: decode= 489.2ms encode=  82.6ms total= 571.8ms ...
  [hang — no further output]
```

## Hypothesis (starting points, verify before acting)

The nosharp pipeline calls **two** WASM operations per run:

1. `transcodeJpegToJxl(jpeg)` — one-shot lossless transcode
2. `createDecoder({...})` → `decoder.push()` / `decoder.events()` / `decoder.dispose()` — streaming decode

Under MT, both likely route through the scheduler/pool layer (`packages/jxl-scheduler/src/pool.ts`) and may spin up new browser-shim Workers. Suspects in order of likelihood:

1. **Worker not terminated on `transcodeJpegToJxl` completion**. The one-shot transcode may not have the same lifecycle teardown as a streaming encode/decode session. Check whether the transcode path acquires a slot from the same pool the streaming decoder uses, and whether it calls `terminate()` (or returns the slot) on success.
2. **`decoder.dispose()` does not release the worker** under MT. The simd tier short-circuits some pool logic; MT goes through the full slot lifecycle. Look for `recycle()` / `release()` semantics in `packages/jxl-scheduler/src/scheduler.ts` and `pool.ts`. CLAUDE.md notes "Workers are stateless between sessions — caching WASM decoder state across session lifetimes would break `recycle()`" — confirm `recycle()` is actually being called.
3. **`BrowserLikeWorker` shim never receives a terminate signal** from `pool.ts`. The shim's `.terminate()` is a passthrough to `NodeWorker.terminate()`, which returns a Promise. If the pool calls it but does not await it, or never calls it under the second-stage decoder lifecycle, the underlying NodeWorker stays alive and accumulates.
4. **Two pools, one TLS**: transcode and decode may each own their own pool instance, both spawning workers under the same `globalThis.Worker` shim. Together they exceed `navigator.hardwareConcurrency` (8 in the shim) which may stall some internal capacity check.

## What to investigate (don't write code yet)

1. `packages/jxl-wasm/src/facade.ts` — find `transcodeJpegToJxl`. Trace which worker / scheduler path it uses. Confirm whether it disposes its slot on success.
2. `packages/jxl-scheduler/src/pool.ts` — read `prewarm`, `acquire`, `release`, `terminate` flows. Note any branch on tier/capability that diverges under MT.
3. `packages/jxl-scheduler/src/scheduler.ts` — `DedupeRegistry`, `recycle()`, fan-out. Look for any code path where a `dispose()` does not actually release the underlying worker.
4. `packages/jxl-worker-browser/src/worker.ts` — message routing, cold-start buffering, shutdown. Look at shutdown ack flow.
5. The `BrowserLikeWorker` shim itself in `timings/fastest/bench-suite.mjs` (or `inbetween-pipeline.mjs` — same shape). Confirm whether `terminate()` is called and whether unhandled errors silently drop.

Add `console.log` instrumentation at the suspect points first. Reproduce the hang. Inspect:
- Number of NodeWorkers spawned (track in shim — increment a counter on `new BrowserLikeWorker`, decrement on `terminate()`)
- Whether `terminate()` is ever called for transcode workers under MT
- Whether `decoder.dispose()` triggers `pool.release()` under MT

## Suggested debugging approach

```js
// Instrument BrowserLikeWorker:
let _workerCount = 0;
class BrowserLikeWorker {
    constructor(url, options = {}) {
        _workerCount++;
        console.log(`[shim] +worker #${_workerCount} (${options.name ?? 'unnamed'})`);
        // ... existing
    }
    terminate() {
        _workerCount--;
        console.log(`[shim] -worker (${_workerCount} remaining)`);
        return this.#worker.terminate();
    }
}
```

If the count grows monotonically across nosharp runs without ever decrementing → leak confirmed. Where the constructor is called but `terminate` never is identifies the leak site.

Alternative: use `node --inspect` and observe handle counts via the inspector — `process._getActiveHandles()` will list active NodeWorkers.

## Constraints

- **Do not change** the existing decode/transcode public API in `facade.ts` or `scheduler.ts`. CLAUDE.md lists layer invariants that must be preserved.
- **Do not** introduce a new "soft preemption", "drain callback", or "pool wrapper" — those are in the rejection log (`docs/rejected optimizations.md`). If your fix looks like one of those, stop and check the rejection log first.
- **Do not touch** fast-jpeg or its bench scripts. Leak is in the existing nosharp path.
- The fix must not regress browser usage. Workers under `globalThis.Worker` in a real browser must still terminate cleanly. If your patch fixes Node but breaks browser teardown, that's worse.

## Acceptance criteria

- `node bench-suite.mjs` (no env filter) runs to completion within ~3 minutes on the reference machine. All 3 pipelines × 7 files × 3 runs = 63 measured points produced, plus the median + per-pipeline-totals summary at the end.
- `tasklist /FI "IMAGENAME eq node.exe"` after the run shows no orphaned node workers from the bench.
- Root cause identified in a short writeup appended to `docs/Grok-Handoff-NoSharpMtLeak.md` under a `## Findings` section. Cite the file(s) + line(s) where the leak lives.
- If the root cause is in `packages/jxl-scheduler/` or `packages/jxl-wasm/`, the fix is a surgical commit. No opportunistic refactor. Per CLAUDE.md.

## Out of scope

- Removing or rewriting the `nosharp` pipeline. It exists as a baseline for fast-jpeg comparison. Don't delete it.
- Replacing the `BrowserLikeWorker` shim with `worker_threads` directly — the shim mirrors browser semantics so Node and browser code paths stay aligned.
- Adding instrumentation to production code. Use scratch logs locally, do not commit them.

## Reference numbers

When fixed, nosharp under MT should produce a row in `=== PER-PIPELINE TOTALS ===` similar to:

```
  nosharp    decode= XXXX.Xms encode=  XXX.Xms total= XXXX.Xms
```

Expected `decode` should be similar to the simd-tier nosharp run (~6477ms) since MT helps encode, not transcode/decode. Expected `total` ~6500-7500ms. Either way: **it must complete**.
