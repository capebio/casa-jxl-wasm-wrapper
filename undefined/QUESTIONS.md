# Deferred findings from EpicCodeReview fixer

## 010-contracts-004: PyramidManifest schema type narrowing

**Status:** Deferred — requires design decision on public API

The function `parsePyramidManifest` normalizes all inputs (schema 1 and 2) to always return schema 2 at runtime. However, the return type `PyramidManifest` in manifest.ts declares `schema: 1 | 2`, which is technically incorrect after normalization.

**Options:**
1. Create a separate `PyramidManifestNormalized` type with `schema: 2`
2. Change the `PyramidManifest.schema` type to `2` (breaking change)
3. Add an overload to the function signature
4. Document the normalization behavior and leave the type as-is

**Note:** This is a type-level contract issue, not a functional bug. Runtime behavior is correct.

## 010-logic-6: decodeTilesParallel total progress count for dc-only mode

**Status:** Deferred — verdict uncertain, path appears unreachable

The default `total = tiles.length * (opts.progressiveStage ? 2 : 1)` doubles the count when `progressiveStage` is set (e.g. `'dc'`). For a dc-only single-pass decode, this would give an incorrect doubled total. However, the dc-only pooled path is excluded by `parallelEligible` guard in decode-level.ts and all callers that set `progressiveStage` also pass `progressTotal` explicitly, making the default unreachable in practice. Requires confirming whether any future caller could reach this with dc-only and no `progressTotal`.

## 010-concurrency-1: getOrCreatePool singleton has no mutex

**Status:** Deferred — JS single-threaded; race scenario is not reachable

The verified evidence acknowledges JS is single-threaded. `getOrCreatePool` is fully synchronous: `pool = p` is assigned before the function returns, so any concurrent async caller that resumes after the first call will see the already-set pool. The factory-swap path sets `pool = null` then immediately (no await) creates and assigns a new pool. No actual TOCTOU window exists in V8's single-threaded execution model. If a genuine race scenario is identified (e.g. SharedWorker shared module), please provide a reproduction case.

## 010-concurrency-6: decodeTiledViewportPooled empty-handles early-exit leaks resources

**Status:** Deferred — leak does not exist in current code

The evidence references line numbers (1155, 1266, 1383) that don't match the current code (1198, 1302, 1411). In the current code, all early-exit returns at lines 1290 and 1298 are inside the outer `try` (line 1198) whose `finally` at line 1409 unconditionally runs `buffersInFlight.delete`. The `liveHandles.length === 0` path acquires zero handles so no release is needed. The `usable.length === 0` path explicitly calls `p.release`. If the code is refactored and the try/finally structure changes, revisit this.

## 010-perf-15: decodeTilesParallel coro closures per handle

**Status:** Deferred — complex refactor, low severity

Extracting the coro async function from `handles.map(async h => ...)` requires sharing approximately 20 mutable variables across all coroutines via a shared state object, restructuring the `decodeOne` retry logic, and careful verification. The allocation cost (one closure per handle per decode, typically 4-8 handles) is minor relative to the WASM decode time. Revisit if profiling shows closure allocation as a bottleneck.
