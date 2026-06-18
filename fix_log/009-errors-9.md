# Task 009-errors-9
**Finding:** getManifest bare catch swallows all decode/parse errors including OOM, returns null silently — packages/jxl-progressive/src/progressive-cache.ts:57-68
**Status:** done
**Tests before:** fail(pre-existing scheduler errors)
**Tests after:** pass (8/8 cache tests pass)

## Change
In the `catch` block of `getManifest`, added `await this.inner.delete(key).catch(() => undefined)` to evict a corrupt entry so the cache self-heals on the next `setManifest` call. Returning null is still correct for callers (missing = null), but a persistently corrupt OPFS entry no longer silently blocks all future cache hits for that URL.

## Diff
```diff
     } catch {
-      return null;
+      // Corrupt entry — evict it so the cache self-heals on next setManifest.
+      await this.inner.delete(key).catch(() => undefined);
+      return null;
     }
```
