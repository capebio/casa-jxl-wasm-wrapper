# Task 009-contracts-3
**Finding:** validateManifest does not check byteStart <= byteEnd or byteEnd > 0 on any tier — packages/jxl-progressive/src/progressive-manifest.ts:99-198
**Status:** done
**Tests before:** fail(pre-existing: types.ts duplicates, scheduler.ts errors — unrelated to this file)
**Tests after:** fail(same pre-existing failures; no new failures introduced; tsc on progressive-manifest.ts clean)

## Change
Added `Number.isFinite` + `>= 0` guard on `byteStart`, `Number.isFinite` + `> 0` guard on `byteEnd`, and `byteEnd > byteStart` cross-check in the tier validation loop. All three checks (contracts-3, logic-3, security-2) target the same location and are implemented together.

## Diff
```diff
-    assertField(typeof t["byteStart"] === "number", `${f}.byteStart`, `${f}.byteStart must be a number`);
-    assertField(typeof t["byteEnd"] === "number", `${f}.byteEnd`, `${f}.byteEnd must be a number`);
+    assertField(typeof t["byteStart"] === "number", `${f}.byteStart`, `${f}.byteStart must be a number`);
+    assertField(
+      Number.isFinite(t["byteStart"] as number) && (t["byteStart"] as number) >= 0,
+      `${f}.byteStart`,
+      `${f}.byteStart must be a finite non-negative number`
+    );
+    assertField(typeof t["byteEnd"] === "number", `${f}.byteEnd`, `${f}.byteEnd must be a number`);
+    assertField(
+      Number.isFinite(t["byteEnd"] as number) && (t["byteEnd"] as number) > 0,
+      `${f}.byteEnd`,
+      `${f}.byteEnd must be a finite positive number`
+    );
+    assertField(
+      (t["byteEnd"] as number) > (t["byteStart"] as number),
+      `${f}.byteEnd`,
+      `${f}.byteEnd must be greater than ${f}.byteStart`
+    );
```
