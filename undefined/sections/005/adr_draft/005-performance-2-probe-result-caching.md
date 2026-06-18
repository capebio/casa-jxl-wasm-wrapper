# ADR: Cache individual probe results at module level (performance-2)

**Status:** Draft  
**File:** packages/jxl-capabilities/src/index.ts:60-82  
**Severity:** info

## Context

`_probeSimd()`, `_probeRelaxedSimd()`, `_probeWasmThreads()`, and `_probeWasmExceptions()` call `WebAssembly.validate()` on every invocation with no per-probe memoization. The only caching is at the `detectTier()` level (via `_cachedTier`) and `getCapabilities()` level (via `_capsPromise`).

After the performance-1 fix, `computeCapabilities` calls `detectTier()` first which caches `_cachedTier`, so duplicate probe calls within a single `getCapabilities()` invocation are already eliminated for the SIMD/relaxed path. However, `wasmThreads` and `wasmExceptions` are still probed once each per `computeCapabilities()` call and are not part of `detectTier()`.

## Decision

Cache each probe result in a module-level nullable boolean (`let _probeSimdResult: boolean | undefined`). Each `_probe*()` function checks its cache before calling `WebAssembly.validate`. `_resetCache()` clears all per-probe caches alongside `_cachedTier`.

## Implementation

```typescript
let _probeSimdResult: boolean | undefined;
let _probeRelaxedResult: boolean | undefined;
let _probeThreadsResult: boolean | undefined;
let _probeEhResult: boolean | undefined;

// In _resetCache():
_probeSimdResult = _probeRelaxedResult = _probeThreadsResult = _probeEhResult = undefined;

// Per-probe:
function _probeSimd(): boolean {
  if (_probeSimdResult !== undefined) return _probeSimdResult;
  try { return (_probeSimdResult = WebAssembly.validate(PROBE_SIMD_BYTES)); }
  catch { return (_probeSimdResult = false); }
}
```

## Consequences

- Eliminates all duplicate `WebAssembly.validate` calls regardless of call order.
- Makes `_resetCache()` more expensive by one extra line, but it is test-only infrastructure.
- The current behaviour (double-probe) was already eliminated for the hot path by performance-1; this is a defence-in-depth cleanup.
- No observable behaviour change in production.
