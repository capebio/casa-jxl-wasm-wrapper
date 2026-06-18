# Task 010-contracts-001
**Finding:** DecodedLevel.format is optional but all decode paths set it; callers cannot rely on its presence without a type guard — packages/jxl-pyramid/src/decode-core.ts:7-19
**Status:** done
**Tests before:** pass (114/114)
**Tests after:** pass (114/114)

## Change
Made `format` a required property (not optional) on the `DecodedLevel` interface. All code paths that construct DecodedLevel objects (REGION_DECODER_RGBA8, REGION_DECODER_RGBA16, and all callers) already set format unconditionally. This change enforces the invariant at the type level, eliminating the need for type guards and matching the actual runtime contract.

## Diff
```diff
 export interface DecodedLevel {
   pixels: Uint8Array;
   width: number;
   height: number;
-  format?: PixelFormat;
+  format: PixelFormat;
   /**
    * When errorPolicy='skip-tile' and tile decodes failed, lists the grid tiles that were zero-filled (L20-1).
```
