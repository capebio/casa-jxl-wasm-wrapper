# Task 009-contracts-5
**Finding:** ProgressiveGallery.observe() silently drops the call when jobs.size >= maxQueuedJobs with no notification to the caller — packages/jxl-progressive/src/progressive-scheduler.ts:210-243
**Status:** done
**Tests before:** fail(pre-existing)
**Tests after:** fail(2 pre-existing TS2412 only)
## Change
Changed the silent `return` at capacity to call `this.opts.onError(id, new Error(...))` before returning, so callers know the image was not registered and will not receive any tier/frame callbacks.
## Diff
```diff
-    if (this.jobs.size >= this.opts.maxQueuedJobs) return;
+    if (this.jobs.size >= this.opts.maxQueuedJobs) {
+      this.opts.onError(id, new Error(`Gallery at capacity (maxQueuedJobs=${this.opts.maxQueuedJobs}); image will not be displayed`));
+      return;
+    }
```
