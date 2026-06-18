# Task 009-contracts-13
**Finding:** makeJob fixture includes prefixChunks: [] which is not a field in the ProgressiveImageJob interface — packages/jxl-progressive/test/scheduler.test.ts:101-127
**Status:** done
**Tests before:** fail(TS2353 prefixChunks unknown property + pre-existing src errors)
**Tests after:** fail(pre-existing src errors only — TS2353 for prefixChunks eliminated)

## Change
Replaced `prefixChunks: []` with `prefixAccum: null` in the `makeJob` fixture (line 122) and replaced `job.prefixChunks = []` with `job.prefixAccum = null` at line 383. The interface field was renamed from `prefixChunks` (array of chunks) to `prefixAccum: Uint8Array | null` (single accumulation buffer). Both call sites now use the correct field name and a compatible `null` value.

## Diff
```diff
--- a/packages/jxl-progressive/test/scheduler.test.ts
+++ b/packages/jxl-progressive/test/scheduler.test.ts
@@ -119,7 +119,7 @@
     errorCount: 0,
     nextRetryAt: 0,
     manifestChecked: false,
-    prefixChunks: [],
+    prefixAccum: null,
     prefixBytes: 0,
     manifestDispatched: false,
@@ -380,7 +380,7 @@
     job.currentTier = "dc";
     job.targetTier = "full";
     job.manifest = null;
-    job.prefixChunks = [];
+    job.prefixAccum = null;
     job.prefixBytes = 0;
```
