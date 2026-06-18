# Task 009-errors-5
**Finding:** `void this.startDecode(job)` discards the returned promise — packages/jxl-progressive/src/progressive-scheduler.ts:483-484
**Status:** done
**Tests before:** fail(pre-existing)
**Tests after:** fail(2 pre-existing TS2412 only)
## Change
Replaced `void this.startDecode(job)` with `this.startDecode(job).catch((e) => { this.opts.onError(...) })`. Any exception escaping `startDecode`'s own catch (e.g. from `onError` callback throwing) is now caught and dispatched rather than becoming an unhandled rejection.
## Diff
```diff
-      void this.startDecode(job);
+      this.startDecode(job).catch((e: unknown) => {
+        this.opts.onError(job.id, e instanceof Error ? e : new Error(String(e)));
+      });
```
