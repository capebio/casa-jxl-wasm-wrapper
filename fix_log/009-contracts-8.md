# Task 009-contracts-8
**Finding:** toSaliency returns Saliency with confidence omitted when opts.confidence is undefined — packages/jxl-progressive/src/saliency-policy.ts:112-128
**Status:** done
**Tests before:** fail(pre-existing: types.ts duplicates, progressive-scheduler.ts TS2412, scheduler.test.ts TS2353)
**Tests after:** fail(same pre-existing failures, no new failures)
## Change
Changed the conditional confidence spread to always emit `confidence: opts.confidence ?? 0`, so the field is never absent. Also tightened the `Saliency` interface to declare `confidence: number` (required) matching `ProgressiveManifest.saliency.confidence: number`.
## Diff
```diff
-  confidence?: number;
+  confidence: number;

-    ...(opts.confidence !== undefined ? { confidence: opts.confidence } : {}),
+    confidence: opts.confidence ?? 0,
```
