# Task 009-concurrency-6
**Finding:** Bitmap fast path reads cache then mutates job.currentTier without rechecking abort signal — packages/jxl-progressive/src/progressive-scheduler.ts:529-537
**Status:** done
**Tests before:** fail(pre-existing)
**Tests after:** fail(2 pre-existing TS2412 only)
## Change
Added `if (abort.signal.aborted) return;` immediately after the `getBitmap` await in the bitmap fast path, before mutating `job.currentTier` and firing `onTier`.
## Diff
```diff
          if (bm) {
+            if (abort.signal.aborted) return;
             job.currentTier = target;
```
