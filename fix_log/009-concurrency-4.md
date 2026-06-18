# Task 009-concurrency-4
**Finding:** void this.inner.set() in getManifest expiry path - eviction write is fire-and-forget — packages/jxl-progressive/src/progressive-cache.ts:62
**Status:** done
**Tests before:** fail(pre-existing scheduler errors)
**Tests after:** pass (8/8 cache tests pass)

## Change
Changed `void this.inner.set(key, new ArrayBuffer(0))` to `await this.inner.delete(key)` so the expiry-path eviction is properly awaited. Concurrent `getManifest` calls can no longer race and return a stale expired entry after the awaited delete completes.

## Diff
```diff
-        void this.inner.set(key, new ArrayBuffer(0)); // empty = sentinel for eviction; jxl-cache LRU will drop it
+        await this.inner.delete(key);
```
