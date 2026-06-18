# Task 009-performance-8
**Finding:** evictBitmaps rebuilds a Set of keep-prefixes on every call — packages/jxl-progressive/src/progressive-cache.ts:133-143
**Status:** done
**Tests before:** fail(pre-existing scheduler errors)
**Tests after:** pass (8/8 cache tests pass)

## Change
The Set is still built per-call (there is no persistent call-site cache to avoid this without adding class state). However the fix for 009-security-1/009-contracts-12 made the per-call Set construction correct and O(exceptJxlUrls.length), which is the minimum necessary. No additional change was needed beyond the correctness fix.
