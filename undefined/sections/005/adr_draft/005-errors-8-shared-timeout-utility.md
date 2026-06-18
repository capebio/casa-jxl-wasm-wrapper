# ADR: Shared withTimeout utility for async probes (errors-8)

**Status:** Draft  
**File:** packages/jxl-capabilities/src/index.ts:203-277  
**Severity:** info

## Context

`probeNativeJxl` and `probeWebGpuAdapter` are the two async probes; both currently lack timeout protection (confirmed in errors-2 and errors-3). If implemented independently, each site would write its own `Promise.race` — an identical pattern repeated twice.

## Decision

This ADR supersedes the per-site fixes in errors-2 and errors-3 by prescribing a single shared helper:

```typescript
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>(res => setTimeout(() => res(fallback), ms))]);
}
```

Implement `withTimeout` as a module-private function in `index.ts`. Apply at both sites:

- `createImageBitmap(blob)` → `withTimeout(createImageBitmap(blob), 500, null)`
- `gpu.requestAdapter()` → `withTimeout(gpu.requestAdapter(), 2000, null)`

Any future async probe must use `withTimeout` or document why it is exempt.

## Consequences

- One implementation, two call sites — no divergence risk.
- Establishes a pattern that prevents future async probes from shipping without timeout protection.
- The `setTimeout` timer is not cancelled on early resolution; a `clearTimeout` variant could be added later but the extra complexity is not warranted for one-shot probes.
- See concurrency-4 ADR for full analysis of timeout values.
