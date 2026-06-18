# Task 009-logic-6
**Finding:** normaliseCenter does not clamp output to [0,1] — packages/jxl-progressive/src/saliency-policy.ts:51-56
**Status:** done
**Tests before:** fail(pre-existing: types.ts duplicates, progressive-scheduler.ts TS2412, scheduler.test.ts TS2353)
**Tests after:** fail(same pre-existing failures, no new failures)
## Change
Added a local `clamp` helper and applied it to both components of the return value in `normaliseCenter`. Pixel coordinates beyond image dimensions (e.g. cx=810 on an 800px-wide image) now produce 1 instead of 1.0125, staying within the [0,1] range required by the manifest validator.
## Diff
```diff
-  return { x: cx / imageWidth, y: cy / imageHeight };
+  const clamp = (v: number) => Math.min(1, Math.max(0, v));
+  return { x: clamp(cx / imageWidth), y: clamp(cy / imageHeight) };
```
