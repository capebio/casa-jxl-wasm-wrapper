# Task 005-concurrency-1
**Finding:** _resetCache() races with in-flight computeCapabilities() producing two simultaneous probes — packages/jxl-capabilities/src/index.ts:6-10
**Status:** done
**Tests before:** pass (9)
**Tests after:** pass (10)

## Change
Added a `_resetGen` generation counter that is incremented by `_resetCache()`. `computeCapabilities(gen)` accepts the generation at invocation time and checks it after all async work completes. If a reset occurred during the async operations, the stale result is discarded (`_capsPromise = undefined`) and `getCapabilities()` is called again so the next caller gets a fresh result. This prevents double GPU adapter requests and double native module imports when a reset races with an in-flight computation.

## Diff
```diff
+let _resetGen = 0;

 export function _resetCache(): void {
+  _resetGen++;
   _cachedTier = undefined;
   _capsPromise = undefined;
+  // Incrementing _resetGen ensures any in-flight computeCapabilities discards its result.
   _gpuAdapterPromise = undefined;
 }
...
 export function getCapabilities(): Promise<Capabilities> {
-  return (_capsPromise ??= computeCapabilities());
+  return (_capsPromise ??= computeCapabilities(_resetGen));
 }

-async function computeCapabilities(): Promise<Capabilities> {
+async function computeCapabilities(gen: number): Promise<Capabilities> {
   ...
+  // concurrency-1: if _resetCache() was called while we were awaiting, our result is stale.
+  if (gen !== _resetGen) {
+    _capsPromise = undefined;
+    return getCapabilities();
+  }
```
