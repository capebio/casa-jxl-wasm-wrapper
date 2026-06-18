# Task 005-logic-2
**Finding:** recommendedQualitySearch returns 'full' for MT tiers with unknown hardware concurrency (hwc=0) — packages/jxl-capabilities/src/index.ts:130-132
**Status:** done
**Tests before:** pass (9)
**Tests after:** pass (10)

## Change
Added `hwc === 0` to the conservative-path condition so that unknown concurrency (hardwareConcurrency unavailable) returns "fast" instead of "full", consistent with the intent of the heuristic.

## Diff
```diff
   const hwc = hwConcurrency ?? (typeof navigator !== "undefined" ? navigator.hardwareConcurrency ?? 0 : 0);
-  if (t === "simd" || (hwc > 0 && hwc <= 2)) return "fast";
+  // hwc===0 means unknown (hardwareConcurrency unavailable) — treat conservatively like low-core
+  if (t === "simd" || hwc === 0 || hwc <= 2) return "fast";
   return "full";
```
