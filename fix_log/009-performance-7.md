# Task 009-performance-7
**Finding:** fullPrefix slice + buffer slice allocates two extra copies of the tier bytes at persist time — packages/jxl-progressive/src/progressive-scheduler.ts:669-680
**Status:** done
**Tests before:** fail(pre-existing)
**Tests after:** fail(2 pre-existing TS2412 only)
## Change
Changed `job.prefixAccum.slice(0, job.prefixBytes)` to `job.prefixAccum.subarray(0, job.prefixBytes)`. `subarray` returns a view with no copy; the subsequent `buffer.slice(byteOffset, byteOffset + byteLength)` still creates one ArrayBuffer copy (needed to pass to `setByteRange`). Net: one copy instead of two for large tier data.
## Diff
```diff
-            const fullPrefix = job.prefixAccum.slice(0, job.prefixBytes);
+            const fullPrefix = job.prefixAccum.subarray(0, job.prefixBytes);
```
