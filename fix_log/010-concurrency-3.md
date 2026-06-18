# Task 010-concurrency-3
**Finding:** buffersInFlight check-then-add is not atomic — packages/jxl-pyramid/src/decode-level.ts:149-157
**Status:** done
**Tests before:** pass (114)
**Tests after:** pass (114)
## Change
Moved `buffersInFlight.add(outBuf)` immediately after the `has()` check to eliminate TOCTOU race where two concurrent decodes with the same outBuffer could both pass the guard.
## Diff
```diff
@@ -149,11 +149,11 @@ export async function decodeTiledViewport(
   if (outBuf) {
     if (outBuf.byteLength < need) throw new PyramidError('INVALID_BUFFER_SIZE', `outBuffer too small (${outBuf.byteLength} < ${need})`);
     if (buffersInFlight.has(outBuf)) throw new PyramidError('BUFFER_IN_USE', 'outBuffer is already in use by another decode');
+    buffersInFlight.add(outBuf);
     // L5-2: 16-bit (bpp=8) requires even offset for safe Uint16Array(underlying, byteOffset) views downstream.
     if (plan.bpp === 8 && (outBuf.byteOffset % 2) !== 0) {
       throw new PyramidError('INVALID_BUFFER_ALIGNMENT', 'outBuffer.byteOffset must be even for 16-bit (bpp=8) pixels');
     }
-    buffersInFlight.add(outBuf);
   }
```
