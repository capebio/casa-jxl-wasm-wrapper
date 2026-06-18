# Task 009-errors-8
**Finding:** RangeNotSupportedError fallback in teeFetch swallows all errors from the second ft() call, not just RangeNotSupportedError — packages/jxl-progressive/src/progressive-scheduler.ts:620-637
**Status:** done
**Tests before:** fail(pre-existing)
**Tests after:** fail(2 pre-existing TS2412 only)
## Change
The `.catch` on the fallback `ft()` call now only stores the error in `fetchError` when `!abort.signal.aborted`. If the job was aborted during the fallback fetch the error is still silently dropped (abort is already handled), but a 404 or network error while not aborted is now stored in `fetchError` and rethrown after the frame loop, allowing `job.nextRetryAt = Infinity` for permanent errors.
## Diff
```diff
-            }).catch((e2: unknown) => { fetchError = e2; });
+            }).catch((e2: unknown) => {
+              if (!abort.signal.aborted) fetchError = e2;
+            });
```
