# Task 005-logic-5
**Finding:** beforeEach does not delete stale SharedArrayBuffer stub when originalSharedArrayBuffer was undefined — packages/jxl-capabilities/test/tier-matrix.test.ts:79-91
**Status:** done
**Tests before:** pass (9/9)
**Tests after:** pass (10/10)

## Change
Added the missing `else { delete (globalAny as any).SharedArrayBuffer; }` branch to `beforeEach` to mirror the identical guard already present in `afterEach`. This ensures a SAB stub installed by a previous test (and not cleaned up if afterEach were skipped) is removed at the start of each test, not only at the end.

## Diff
```diff
   if (originalSharedArrayBuffer) {
     (globalAny as any).SharedArrayBuffer = originalSharedArrayBuffer;
+  } else {
+    delete (globalAny as any).SharedArrayBuffer;
   }
```
