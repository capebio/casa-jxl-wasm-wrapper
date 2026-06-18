# ADR: Add timeout protection to probeNativeJxl and probeWebGpuAdapter (concurrency-4)

**Status:** Draft  
**File:** packages/jxl-capabilities/src/index.ts:166-199  
**Severity:** info

## Context

`probeNativeJxl()` awaits `createImageBitmap(blob)` and `probeWebGpuAdapter()` awaits `gpu.requestAdapter()`, both without any timeout. Both are memoized (`_capsPromise`, `_gpuAdapterPromise`), so a single stall permanently blocks all future callers in the page lifetime. See also errors-2 and errors-3.

## Decision

Add a shared `withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T>` utility and apply it at both probe sites.

## Implementation

```typescript
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>(res => setTimeout(() => res(fallback), ms))]);
}
```

Apply:
- `probeNativeJxl`: wrap `createImageBitmap(blob)` with `withTimeout(..., 500, null)` (500 ms is generous for an in-memory decode).
- `probeWebGpuAdapter`: wrap `gpu.requestAdapter()` with `withTimeout(..., 2000, null)` (2 s covers slow driver enumeration).

## Consequences

- Eliminates the indefinite-hang risk for both async probes.
- 500 ms / 2 s timeouts are conservative; benchmarking on real devices may allow tightening.
- The timeout timer is not cancelled if the original promise resolves first; this is acceptable because both probes are one-shot and the timer reference is not held.
- `withTimeout` uses `setTimeout` which is universally available in browser and Node.js 15+; no new dependencies.
- Test harness (`freshCapsAndTier`) does not stub `setTimeout` so it is unaffected.
