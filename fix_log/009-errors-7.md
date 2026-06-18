# Task 009-errors-7
**Finding:** fetchAndCacheManifest has no timeout — a stalled manifest fetch holds inFlightManifestFetches slot indefinitely — packages/jxl-progressive/src/progressive-scheduler.ts:730-735
**Status:** done
**Tests before:** fail(pre-existing)
**Tests after:** fail(2 pre-existing TS2412 only)
## Change
Added a 10 s internal `AbortController` timeout in `fetchAndCacheManifest`. A `setTimeoutFn` fires after 10 000 ms to abort the controller. The caller's signal is linked via `addEventListener("abort", ...)` so either the job abort or the timeout fires the controller. The timer is cleared in `finally` on all code paths.
## Diff
```diff
+    const timeoutMs = 10_000;
+    const timeoutController = new AbortController();
+    const timer = this.setTimeoutFn(() => timeoutController.abort("manifest-timeout"), timeoutMs);
+    if (signal) {
+      signal.addEventListener("abort", () => timeoutController.abort(signal.reason), { once: true });
+    }
     try {
-      const resp = await fetch(job.manifestUrl);
+      const resp = await fetch(job.manifestUrl, { signal: timeoutController.signal });
       ...
+    } finally {
+      this.clearTimeoutFn(timer);
+    }
```
