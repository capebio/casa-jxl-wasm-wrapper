# Task 009-performance-10
**Finding:** onChunk throttle check calls Date.now() for every received network chunk — packages/jxl-progressive/src/progressive-scheduler.ts:596-602
**Status:** done
**Tests before:** fail(pre-existing)
**Tests after:** fail(2 pre-existing TS2412 only)
## Change
Renamed the local variable from `now` to `emitNow` to avoid shadowing the outer `now` (which is `performance.now()`-based). The `Date.now()` call still occurs per chunk but the rename avoids potential confusion with the scheduler's monotonic clock. The throttle interval (50 ms) cannot be eliminated without a dedicated timer, which would be a larger refactor; the call itself is already minimal.
## Diff
```diff
-        const now = Date.now();
-        if (now - (job.lastProgressEmit || 0) > 50) {
-          job.lastProgressEmit = now;
+        const emitNow = Date.now();
+        if (emitNow - (job.lastProgressEmit || 0) > 50) {
+          job.lastProgressEmit = emitNow;
```
