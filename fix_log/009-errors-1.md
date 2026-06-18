# Task 009-errors-1
**Finding:** prefetchManifest swallows all errors including OOM and stack overflow, losing diagnostics entirely — packages/jxl-progressive/src/progressive-scheduler.ts:427-439
**Status:** done
**Tests before:** fail(pre-existing errors in types.ts + prefixChunks)
**Tests after:** fail(2 pre-existing TS2412 only)
## Change
Replaced `.catch(() => {})` with `.catch((e) => { this.opts.onError(...) })` so manifest prefetch errors are dispatched to the caller. Also dispatches `onManifest` inside the `.then` when the manifest arrives via prefetch path (fixing contracts-9 simultaneously).
## Diff
```diff
-      .catch(() => {})
+      .catch((e: unknown) => {
+        this.opts.onError(job.id, e instanceof Error ? e : new Error(String(e)));
+      })
+      .then((m) => {
+        if (m !== null && job.manifest === null) {
+          job.manifest = m;
+          if (!job.manifestDispatched) {
+            job.manifestDispatched = true;
+            this.opts.onManifest(job.id, m);
+          }
+        }
+      })
```
