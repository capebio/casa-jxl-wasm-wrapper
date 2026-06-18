# Task 010-logic-3

**Finding:** convergedByteEnd == bytes is accepted but should be rejected as non-truncating — packages/jxl-pyramid/src/manifest-validate.ts:116-117

**Status:** done

**Tests before:** 114 pass, 0 fail

**Tests after:** 114 pass, 0 fail

## Change

Changed the condition from `cbe > bytes` to `cbe >= bytes` to reject convergedByteEnd values equal to the total bytes. A convergedByteEnd equal to bytes is useless since it truncates nothing and should not be silently accepted in the manifest.

## Diff

```diff
   if (o["convergedByteEnd"] !== undefined) {
     const cbe = requireNumber(o["convergedByteEnd"], `${path}.convergedByteEnd`);
-    if (cbe > bytes) fail(`${path}.convergedByteEnd`, `${cbe} exceeds bytes ${bytes}`);
+    if (cbe >= bytes) fail(`${path}.convergedByteEnd`, `${cbe} must be less than bytes ${bytes}`);
     level.convergedByteEnd = cbe;
   }
```
