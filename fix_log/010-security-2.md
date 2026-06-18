# Task 010-security-2
**Finding:** ProducedBy.params stored without sanitisation allows attacker-controlled opaque dict — packages/jxl-pyramid/src/manifest-validate.ts:73-76
**Status:** done
**Tests before:** pass (114)
**Tests after:** pass (114)

## Change
Applied `sanitizeOpaqueObject` (introduced for security-1) to `result.params` in `validateProducedBy`, replacing the bare `requireObject` + verbatim assignment.

## Diff
```diff
-  if (o["params"] !== undefined) {
-    requireObject(o["params"], `${path}.params`);
-    result.params = o["params"] as Record<string, unknown>;
-  }
+  if (o["params"] !== undefined) {
+    result.params = sanitizeOpaqueObject(requireObject(o["params"], `${path}.params`), `${path}.params`);
+  }
```
