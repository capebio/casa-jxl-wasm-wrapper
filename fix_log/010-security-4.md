# Task 010-security-4

**Finding:** contenthash accepted as any non-empty string with no format constraint, enabling cache-key confusion — packages/jxl-pyramid/src/manifest-validate.ts:92-93

**Status:** done

**Tests before:** 114 pass, 0 fail

**Tests after:** 114 pass, 0 fail

## Change

Added regex validation to ensure contenthash values are hexadecimal-only (matching `^[a-fA-F0-9]+$`). This prevents cache-key confusion attacks where a malicious contenthash with colons or other special characters could collide with or override cache entries for different tiles or levels.

## Diff

```diff
   const tiled = requireBoolean(o["tiled"], `${path}.tiled`);
+  if (!/^[a-fA-F0-9]+$/.test(contenthash)) fail(`${path}.contenthash`, `must be hexadecimal, got "${contenthash}"`);
 
   const level: PyramidLevel = {
     ...
```
