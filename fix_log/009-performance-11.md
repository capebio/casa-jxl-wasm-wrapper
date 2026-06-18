# Task 009-performance-11
**Finding:** concatUint8Arrays filters with instanceof checks on every element even when called with a known-valid array — packages/jxl-progressive/src/progressive-scheduler.ts:105-116
**Status:** done
**Tests before:** fail(pre-existing)
**Tests after:** fail(2 pre-existing TS2412 only)
## Change
Removed the `instanceof Uint8Array &&` check from the filter predicate. All callers within the package pass arrays of `Uint8Array` objects; the type narrowing cast is also removed since the input type already guarantees `Uint8Array`.
## Diff
```diff
-  const valid = chunks.filter((c): c is Uint8Array => c instanceof Uint8Array && c.byteLength > 0);
+  const valid = chunks.filter((c) => c.byteLength > 0);
```
