# Task 009-security-1
**Finding:** Cache key separator '#' in jxlUrl causes key collision between manifest/byte-range namespaces and wrong eviction in evictBitmaps — packages/jxl-progressive/src/progressive-cache.ts:93-107
**Status:** done
**Tests before:** fail(pre-existing scheduler errors)
**Tests after:** pass (8/8 cache tests pass)

## Change
Replaced `"#"` tier separator with `"\0"` (null byte, never valid in a URL or tier name) in all key constructions: `getByteRange`, `setByteRange`, `getBitmap`, `setBitmap`, `evictBitmaps`, and `invalidate`. The `evictBitmaps` urlPart extraction now uses `indexOf(TIER_SEP)` which is unambiguous. The `invalidate` bitmap eviction now uses `key.startsWith(bitmapPrefix)` instead of `key.includes(jxlUrl)` to prevent cross-URL substring matches.

## Diff
```diff
+const TIER_SEP = "\0";
 ...
-    const buf = await this.inner.get(BYTES_KEY_PREFIX + jxlUrl + "#" + tier);
+    const buf = await this.inner.get(BYTES_KEY_PREFIX + jxlUrl + TIER_SEP + tier);
 ...
-    const urlPart = key.slice(0, key.lastIndexOf("#"));
+    const sepIdx = key.indexOf(TIER_SEP);
+    const urlPart = sepIdx === -1 ? key : key.slice(0, sepIdx + 1);
 ...
-    for (const key of [...this.bitmapStore.keys()]) {
-      if (key.includes(jxlUrl)) this.bitmapStore.delete(key);
-    }
+    const bitmapPrefix = BITMAP_KEY_PREFIX + jxlUrl + TIER_SEP;
+    for (const key of this.bitmapStore.keys()) {
+      if (key.startsWith(bitmapPrefix)) this.bitmapStore.delete(key);
+    }
```
