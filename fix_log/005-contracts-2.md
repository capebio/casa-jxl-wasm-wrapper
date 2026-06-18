# Task 005-contracts-2
**Finding:** Capabilities.libjxlVersion is permanently 'unknown' despite a typed string contract — packages/jxl-capabilities/src/index.ts:269
**Status:** done
**Tests before:** pass (9)
**Tests after:** pass (10)

## Change
Changed `libjxlVersion: string` to `libjxlVersion: string | null` in the `Capabilities` interface and changed the hardcoded `"unknown"` value to `null`. Callers can now use `caps.libjxlVersion !== null` to distinguish "version available" from "version unavailable", making the contract honest.

## Diff
```diff
-  libjxlVersion: string;
+  libjxlVersion: string | null;
...
-    libjxlVersion: "unknown",
+    libjxlVersion: null,
```
