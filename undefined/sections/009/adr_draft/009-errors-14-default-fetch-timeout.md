# ADR: Default Fetch Timeout Pattern

**Task:** 009-errors-14
**Status:** proposed (partially implemented)

## Context

All fetch calls in the progressive scheduler (manifest, tier, full) are unbounded without a timeout. A stalled TCP connection holds decoder slots and manifest-fetch counters indefinitely.

## Current State

`fetchAndCacheManifest` now has an internal 10 s timeout (added in 009-errors-7 fix). Tier and full fetches (`fetchTier`, `fetchFull`, `fetchTierWithPrefix`) still rely entirely on the caller's `AbortSignal` — if the caller never aborts, the fetch is unbounded.

## Decision

Add a `fetchTimeoutMs?: number` option to `GalleryOptions` (default: `30_000` ms). Create a utility:

```typescript
function withTimeout(signal: AbortSignal, ms: number): AbortSignal {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort("fetch-timeout"), ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); ctrl.abort(signal.reason); }, { once: true });
  return ctrl.signal;
}
```

Thread `withTimeout(abort.signal, this.opts.fetchTimeoutMs)` into every `fetchTier`/`fetchFull`/`fetchTierWithPrefix` call inside `startDecode`.

## Consequences

- Adds one `GalleryOptions` field (`fetchTimeoutMs`).
- A timed-out fetch triggers the `catch` block in `startDecode`, increments `errorCount`, and arms the retry timer — same as any network error.
- `fetchAndCacheManifest` can share the same utility, removing its inline timeout controller.
- Deferred because `fetchTier`/`fetchFull` live in `progressive-stream.ts` which is outside the current task's file scope.
