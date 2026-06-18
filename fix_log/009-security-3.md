# Task 009-security-3
**Finding:** No length bounds on encoder.name, encoder.libjxlVersion, encoder.flags array, or perceptual passthrough - malicious manifest can cause unbounded cache storage — packages/jxl-progressive/src/progressive-manifest.ts:136-140
**Status:** done
**Tests before:** fail(pre-existing)
**Tests after:** fail(same pre-existing; tsc on progressive-manifest.ts clean)

## Change
Added four length-bound assertField calls: `encoder.name <= 256 chars`, `encoder.libjxlVersion <= 64 chars`, `encoder.flags.length <= 64 entries`, `perceptual keys count <= 32`. Bounds are generous enough that no legitimate manifest is affected and tight enough to prevent megabyte-sized storage amplification.

## Diff
```diff
   assertField(typeof enc["name"] === "string", "encoder.name", "encoder.name must be a string");
+  assertField((enc["name"] as string).length <= 256, "encoder.name", "encoder.name must be <= 256 chars");
   assertField(typeof enc["libjxlVersion"] === "string", "encoder.libjxlVersion", "encoder.libjxlVersion must be a string");
+  assertField((enc["libjxlVersion"] as string).length <= 64, "encoder.libjxlVersion", "encoder.libjxlVersion must be <= 64 chars");
   assertField(Array.isArray(enc["flags"]), "encoder.flags", "encoder.flags must be an array");
+  assertField((enc["flags"] as unknown[]).length <= 64, "encoder.flags", "encoder.flags must have <= 64 entries");
 
   // perceptual passthrough
   if (obj["perceptual"] !== undefined) {
     assertField(typeof obj["perceptual"] === "object" ... );
+    assertField(Object.keys(obj["perceptual"] as object).length <= 32, "perceptual", "perceptual must have <= 32 keys");
   }
```
