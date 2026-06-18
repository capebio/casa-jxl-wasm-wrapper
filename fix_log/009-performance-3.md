# Task 009-performance-3
**Finding:** armEarliestRetryTimer iterates all jobs on every tick even when no jobs are retrying — packages/jxl-progressive/src/progressive-scheduler.ts:470
**Status:** done
**Tests before:** fail(pre-existing)
**Tests after:** fail(2 pre-existing TS2412 only)
## Change
Added an early-continue guard `if (!j.nextRetryAt || j.nextRetryAt <= now) continue` inside `armEarliestRetryTimer`. Jobs with no retry pending (the common case) are skipped immediately without the `t > now` comparison allocating intermediate expressions.
## Diff
```diff
-      if (typeof t === "number" && t > now && (earliest === null || t < earliest)) {
-        earliest = t;
-      }
+      if (!j.nextRetryAt || j.nextRetryAt <= now) continue;
+      const t = j.nextRetryAt;
+      if (earliest === null || t < earliest) earliest = t;
```
