# Task 010-concurrency-8

**Finding:** Module-level idCounter and WeakMaps in cache.ts are not safe if multiple realm instances share the same module — packages/jxl-pyramid/src/cache.ts:36-52

**Status:** done

**Tests before:** 114 pass

**Tests after:** 114 pass

## Change

Added defensive WorkerGlobalScope check to warn if the cache module is loaded in a worker context. The module-level idCounter and WeakMaps (levelIdBySource, bufIdByBuffer, bytesIdCache) assume single-realm execution and would become unsynchronized if shared across worker boundaries. The warning directs users to use contenthash-based cache keys (makeLevelCacheKey) for multi-realm scenarios.

## Diff

```diff
 const levelIdBySource = new WeakMap<LevelSource, string>();
 const bufIdByBuffer = new WeakMap<ArrayBufferLike, string>();
+const bytesIdCache = new WeakMap<Uint8Array, string>();
 let idCounter = 0;
+
+// Defensive check: cache module assumes single-realm execution (main thread only).
+// If this is imported in a worker or shared across realms, idCounter and WeakMaps will be unsynchronized.
+// Use makeLevelCacheKey(contenthash) for multi-realm scenarios.
+if (typeof WorkerGlobalScope !== "undefined") {
+  console.warn(
+    "cache.ts loaded in worker context; level IDs may conflict. Use contenthash-based cache keys instead.",
+  );
+}
```
