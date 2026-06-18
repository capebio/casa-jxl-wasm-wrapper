# Task 009-contracts-12
**Finding:** evictBitmaps prefix-strips jxlUrl from bitmap keys using lastIndexOf('#') - fails for jxlUrls containing '#' — packages/jxl-progressive/src/progressive-cache.ts:133-143
**Status:** done
**Tests before:** fail(pre-existing scheduler errors)
**Tests after:** pass (8/8 cache tests pass)

## Change
Replaced `key.lastIndexOf("#")` with `key.indexOf(TIER_SEP)` (null byte separator) which is unambiguous because null bytes cannot appear in URLs or tier names. Also updated the `keep` set to include the separator character so prefix comparison is exact.

## Diff
```diff
-    const keep = new Set(exceptJxlUrls.map((u) => BITMAP_KEY_PREFIX + u));
+    const keep = new Set(exceptJxlUrls.map((u) => BITMAP_KEY_PREFIX + u + TIER_SEP));
 ...
-      const urlPart = key.slice(0, key.lastIndexOf("#"));
+      const sepIdx = key.indexOf(TIER_SEP);
+      const urlPart = sepIdx === -1 ? key : key.slice(0, sepIdx + 1);
```
