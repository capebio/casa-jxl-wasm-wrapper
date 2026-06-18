# Task 009-contracts-7
**Finding:** getManifest writes an empty ArrayBuffer as a 'sentinel for eviction' but the underlying JxlCacheBrowser.set() contract does not guarantee that a zero-length value is evicted — packages/jxl-progressive/src/progressive-cache.ts:53-69
**Status:** done
**Tests before:** fail(3) (pre-existing errors in progressive-scheduler.ts blocked tsc; cache.test.js: 8/8 pass after manual run)
**Tests after:** pass (8/8 cache tests pass)

## Change
Replaced `void this.inner.set(key, new ArrayBuffer(0))` in the expiry path with `await this.inner.delete(key)`, using the proper JxlCache.delete() API. The same fix was applied to `invalidateManifest` and the byte-range slots in `invalidate`. The empty-buffer sentinel is now gone from all paths.

## Diff
```diff
-        void this.inner.set(key, new ArrayBuffer(0)); // empty = sentinel for eviction; jxl-cache LRU will drop it
+        await this.inner.delete(key);
```
```diff
-    await this.inner.set(MANIFEST_KEY_PREFIX + jxlUrl, new ArrayBuffer(0));
+    await this.inner.delete(MANIFEST_KEY_PREFIX + jxlUrl);
```
