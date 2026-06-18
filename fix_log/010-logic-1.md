# Task 010-logic-1
**Finding:** deadlineHit failedTiles loop uses hardcoded level=0 instead of source.level — packages/jxl-pyramid/src/decode-level.ts:392-401
**Status:** done
**Tests before:** pass (114)
**Tests after:** pass (114)
## Change
Replaced hardcoded `0` with `source.level ?? 0` in tileIdOf() call at line 389, ensuring correct level is used when building failed tile IDs at deadline. Also updated to use `failedTileKeys.add(k)` instead of `failedTiles.push(id)`.
## Diff
```diff
@@ -385,11 +385,11 @@ export async function decodeTiledViewport(
       if (deadlineHit) {
         for (let i = 0; i < n; i++) {
           const t = plan.tiles[i]!;
-          const id = tileIdOf(t, source.tileSize, 0);
+          const id = tileIdOf(t, source.tileSize, source.level ?? 0);
           const k = tileKey(id);
           if (!stitchedFinal.has(k)) {
-            failedTiles.push(id);
+            failedTileKeys.add(k);
           }
         }
       }
```
