# Task 010-errors-17
**Finding:** decodeTileBytesProgressive: events() async iterator abandonment on decoder.push() throw leaks decoder — packages/jxl-pyramid/src/decode-level.ts:479-504
**Status:** done
**Tests before:** pass (114)
**Tests after:** pass (114)
## Change
Added `await drainOutcome.catch(() => {})` as the first statement in the `finally` block of `decodeTileBytesProgressive`. When the `try` block exits early (e.g. due to a throw), the `drainOutcome` IIFE that holds the `events()` async generator was previously abandoned without being settled. Awaiting it in `finally` (before `dispose()`) allows the generator's own `finally` block to run and free WASM heap resources, preventing an unhandled rejection from a disposed-decoder read.
## Diff
```diff
--- a/packages/jxl-pyramid/src/decode-level.ts
+++ b/packages/jxl-pyramid/src/decode-level.ts
@@ -497,6 +497,7 @@ async function decodeTileBytesProgressive(
   } finally {
+    await drainOutcome.catch(() => {});
     await Promise.resolve(decoder.dispose()).catch(() => {});
   }
 }
```
