# Task 010-contracts-009
**Finding:** Direct non-pooled path stamps iccProfile via (result as any).iccProfile instead of typed field assignment — packages/jxl-pyramid/src/decode-level.ts:456-459
**Status:** done
**Tests before:** pass (114)
**Tests after:** pass (114)
## Change
Replaced `(result as any).iccProfile = icc` with typed `result.iccProfile = icc`. The DecodedLevel interface already declares `iccProfile?: Uint8Array`, so the type cast is unnecessary and unsafe.
## Diff
```diff
@@ -450,7 +450,7 @@ export async function decodeTiledViewport(
     // Agent6-4
     if (options?.preserveMetadata) {
       const icc = await ensureIccProfile(source, options);
-      if (icc) (result as any).iccProfile = icc;
+      if (icc) result.iccProfile = icc;
     }
     return result;
```
