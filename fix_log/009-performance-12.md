# Task 009-performance-12
**Finding:** selectTiers allocates a filtered array (before70) even when the result would be the same element as dcEvent — packages/jxl-progressive/src/progressive-profile.ts:77-80
**Status:** done
**Tests before:** fail(pre-existing TS errors in other files)
**Tests after:** fail(same pre-existing TS errors; no new errors)

## Change
Replaced `events.filter(e => e.byteOffset < totalBytes * 0.7)` + last-element access with a reverse-scan loop. The threshold is computed once and the loop exits on the first qualifying element found from the end, avoiding the intermediate array allocation entirely.

## Diff
```diff
-  // Preview tier: last event before 70% of file, distinct from dc.
-  const before70 = events.filter((e) => e.byteOffset < totalBytes * 0.7);
-  const previewEvent =
-    before70.length > 0 ? before70[before70.length - 1] : undefined;
+  // Preview tier: last event before 70% of file, distinct from dc.
+  // Use a reverse scan to avoid allocating a filtered array.
+  const threshold70 = totalBytes * 0.7;
+  let previewEvent: ProgressionEvent | undefined;
+  for (let i = events.length - 1; i >= 0; i--) {
+    if ((events[i] as ProgressionEvent).byteOffset < threshold70) {
+      previewEvent = events[i];
+      break;
+    }
+  }
```
