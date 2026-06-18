# Task 005-logic-1
**Finding:** recommendedEffort returns effort=7 for unknown hardware concurrency (hwc=0) — packages/jxl-capabilities/src/index.ts:122-123
**Status:** done
**Tests before:** pass (9)
**Tests after:** pass (10)

## Change
Changed the condition from `hwc > 0 && hwc <= 2 ? 6 : 7` to `hwc > 0 && hwc > 2 ? 7 : 6` so that hwc=0 (unknown) falls into the conservative path (effort=6) rather than the aggressive path (effort=7). Also narrowed the return type from `1|2|3|4|5|6|7|8|9` to `4|6|7` (covers 005-contracts-3 simultaneously).

## Diff
```diff
-export function recommendedEffort(hwConcurrency?: number): 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 {
+export function recommendedEffort(hwConcurrency?: number): 4 | 6 | 7 {
   const tier = detectTier();
   if (tier === "scalar") return 4;
   if (tier === "simd") return 6;
   const hwc = hwConcurrency ?? (typeof navigator !== "undefined" ? navigator.hardwareConcurrency ?? 0 : 0);
-  return hwc > 0 && hwc <= 2 ? 6 : 7; // MT tier on a 2-core device: don't pay effort-7 (CAP-7)
+  // hwc===0 means unknown (hardwareConcurrency unavailable) — treat conservatively like low-core (CAP-7)
+  return hwc > 0 && hwc > 2 ? 7 : 6;
 }
```
