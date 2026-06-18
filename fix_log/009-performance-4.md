# Task 009-performance-4
**Finding:** onChunk allocates a new Uint8Array wrapper for every incoming fetch chunk — packages/jxl-progressive/src/progressive-scheduler.ts:584-604
**Status:** done
**Tests before:** fail(pre-existing)
**Tests after:** fail(2 pre-existing TS2412 only)
## Change
Removed `const chunk = new Uint8Array(c)` and used `c` directly. The tee stream already provides a Uint8Array; wrapping it was a full allocation+memcopy on every network chunk. All references to `chunk` in the function body replaced with `c`.
## Diff
```diff
-        const chunk = new Uint8Array(c);
-        const needed = job.prefixBytes + chunk.byteLength;
+        const needed = job.prefixBytes + c.byteLength;
         ...
-        job.prefixAccum.set(chunk, job.prefixBytes);
-        job.prefixBytes += chunk.byteLength;
-        capturedBytes += chunk.byteLength;
+        job.prefixAccum.set(c, job.prefixBytes);
+        job.prefixBytes += c.byteLength;
+        capturedBytes += c.byteLength;
```
