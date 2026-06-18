# Task 010-errors-7
**Finding:** ensureIccProfile silently swallows all errors and always resolves null on failure — packages/jxl-pyramid/src/decode-core.ts:392-418
**Status:** done
**Tests before:** pass (114/114)
**Tests after:** pass (114/114)

## Change
Added error logging before returning null in the catch block. The function now logs the error to console.error so that ICC profile extraction failures are observable for debugging, while maintaining the same null-return behavior for the caller.

## Diff
```diff
-    } catch {
+    } catch (err) {
+      console.error('ensureIccProfile failed:', err);
       return null;
     }
```
