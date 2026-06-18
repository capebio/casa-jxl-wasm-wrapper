# Task 009-performance-6
**Finding:** checkHash converts SHA-256 digest to hex via Array.from + map + join - allocates three intermediate collections — packages/jxl-progressive/src/progressive-manifest.ts:218-223
**Status:** done
**Tests before:** fail(pre-existing)
**Tests after:** fail(same pre-existing; tsc on progressive-manifest.ts clean)

## Change
Replaced `Array.from(new Uint8Array(hashBuf)).map(...).join("")` (3 allocations: Array, mapped Array, joined string) with a direct `for` loop over `new Uint8Array(hashBuf)` building the hex string via `+=`. Single allocation for the result string.

## Diff
```diff
-    const hashBuf = await globalThis.crypto.subtle.digest("SHA-256", jxlBytes);
-    hashHex = Array.from(new Uint8Array(hashBuf))
-      .map((b) => b.toString(16).padStart(2, "0"))
-      .join("");
+    const hashBuf = await globalThis.crypto.subtle.digest("SHA-256", jxlBytes);
+    const hashBytes = new Uint8Array(hashBuf);
+    let hex = "";
+    for (let i = 0; i < hashBytes.length; i++) {
+      hex += hashBytes[i]!.toString(16).padStart(2, "0");
+    }
+    hashHex = hex;
```
