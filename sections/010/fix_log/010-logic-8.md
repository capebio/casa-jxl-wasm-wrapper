# Task 010-logic-8
**Finding:** armAllExcessIdle iterates in LIFO (hottest) order but reaping should prefer FIFO (coldest) — packages/jxl-pyramid/src/tiled-decode-pool.ts:581-594
**Status:** done
**Tests before:** pass(114)
**Tests after:** pass(114)
## Change
Changed `armAllExcessIdle` to iterate from index 0 up to `idle.length - minIdle` (cold/oldest workers) instead of from `idle.length - 1` down to `minIdle` (hot/newest workers). Cold workers at low indices are least likely to be acquired next (LIFO pop from the end) and should be reaped preferentially.
## Diff
```diff
-    for (let i = this.idle.length - 1; i >= this.minIdle; i--) {
-      const h = this.idle[i];
-      if (h) this.armIdleTimerFor(h);
-    }
+    const excessEnd = this.idle.length - this.minIdle;
+    for (let i = 0; i < excessEnd; i++) {
+      const h = this.idle[i];
+      if (h) this.armIdleTimerFor(h);
+    }
```
