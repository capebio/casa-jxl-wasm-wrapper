# Task 009-concurrency-8
**Finding:** teeFetch pump promise swallows errors silently; toCapture ReadableStream reader is not released on abort — packages/jxl-progressive/src/progressive-scheduler.ts:608-651
**Status:** done
**Tests before:** fail(pre-existing)
**Tests after:** fail(2 pre-existing TS2412 only)
## Change
Refactored the pump from `.catch(() => {})` appended to an IIFE into a try/catch/finally structure. The `finally` block calls `r.cancel().catch(() => {})` to release the reader on both normal completion and abort/error paths, preventing the stream consumer from being leaked.
## Diff
```diff
-      pump = (async () => {
-        const r = toCapture.getReader();
-        for (;;) {
-          const { done, value } = await r.read();
-          if (done) break;
-          onChunk(value);
-        }
-      })().catch(() => {
-        /* abort/network: partial is valid prefix for resume */
-      });
+      pump = (async () => {
+        const r = toCapture.getReader();
+        try {
+          for (;;) {
+            const { done, value } = await r.read();
+            if (done) break;
+            onChunk(value);
+          }
+        } catch {
+          /* abort/network: partial is valid prefix for resume */
+        } finally {
+          r.cancel().catch(() => {});
+        }
+      })();
```
