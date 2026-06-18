# Task 010-errors-13

**Finding:** Aspect ratio validation uses division without guarding height=0 — packages/jxl-pyramid/src/manifest-validate.ts:159-162

**Status:** done

**Tests before:** 114 pass, 0 fail

**Tests after:** 114 pass, 0 fail

## Change

Added guard to check `height <= 0` before computing `width / height` in aspect ratio validation. This prevents division producing Infinity and gives a clear error message about the actual problem (zero/negative height) rather than a confusing aspect ratio mismatch.

## Diff

```diff
   const width = requireNumber(o["width"], "manifest.width");
   const height = requireNumber(o["height"], "manifest.height");
   const aspect = requireNumber(o["aspect"], "manifest.aspect");
 
+  if (height <= 0) fail("manifest.height", `height must be positive, got ${height}`);
   if (Math.abs(aspect - width / height) > 1e-3) {
     fail("manifest.aspect", `aspect ${aspect} inconsistent with width/height ratio ${width}/${height} = ${(width / height).toFixed(6)}`);
   }
```
