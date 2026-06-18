# Task 010-errors-9
**Finding:** Progressive Phase 1 DC errors with fail-fast policy propagate as non-PyramidError, losing typed error code — packages/jxl-pyramid/src/decode-level.ts:231-311
**Status:** done
**Tests before:** pass (114)
**Tests after:** pass (114)
## Change
Added error wrapping on fail-fast paths in both dc-phase and final-phase: if error is not already a PyramidError, wrap it in PyramidError with 'JXTC_PARSE' code. This ensures errors from decodeTileBytesProgressive are properly typed and preserve the error code contract.
## Diff
```diff
@@ -298,7 +298,8 @@ export async function decodeTiledViewport(
           onTile?.(t, completed, prog);
           return;
         }
-        throw e;
+        if (e instanceof PyramidError) throw e;
+        throw new PyramidError('JXTC_PARSE', `tile progressive dc: ${e instanceof Error ? e.message : String(e)}`, e);
       }
     });
 
@@ -372,7 +373,8 @@ export async function decodeTiledViewport(
           onTile?.(t, completed, prog);
           return;
         }
-        throw e;
+        if (e instanceof PyramidError) throw e;
+        throw new PyramidError('JXTC_PARSE', `tile progressive final: ${e instanceof Error ? e.message : String(e)}`, e);
       }
     });
```
