# Task 010-logic-2
**Finding:** dc-then-final pooled path fires final onTile for cache-hits before the final decode pass runs — packages/jxl-pyramid/src/tiled-decode-pool.ts:1307-1332
**Status:** done
**Tests before:** pass(114)
**Tests after:** pass(114)
## Change
Moved the cache-hit tiles' `stage: 'final'` `onTile` notifications to after `decodeTilesParallel` for the final pass completes. The `finOpts.progressBase` now uses `finBase = orderedMisses.length + prewarmCompleted` (unchanged value), and hits' final events fire after all misses have finished their final decode, making progress monotonic.
## Diff
```diff
-        let finalCompleted = orderedMisses.length + prewarmCompleted;
-        for (const item of hits) {
-          finalCompleted += 1;
-          onTile?.(item.region, finalCompleted, { id: item.id, key: tileKey(item.id), stage: 'final', completed: finalCompleted, total });
-        }
-        
-        const finOpts: any = {
+        const finBase = orderedMisses.length + prewarmCompleted;
+        const finOpts: any = {
           ...baseTileOpts,
           progressiveStage: 'final' as const,
-          progressBase: finalCompleted,
+          progressBase: finBase,
           progressTotal: total,
           ...
         };
         ...
         await decodeTilesParallel(...finOpts...);
+
+        let finalCompleted = finBase + orderedMisses.length;
+        for (const item of hits) {
+          finalCompleted += 1;
+          onTile?.(item.region, finalCompleted, { id: item.id, key: tileKey(item.id), stage: 'final', completed: finalCompleted, total });
+        }
```
