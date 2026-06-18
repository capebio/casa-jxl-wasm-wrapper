# Task 009-performance-5
**Finding:** New TextDecoder instance allocated on every getManifest cache hit — packages/jxl-progressive/src/progressive-cache.ts:57-59
**Status:** done
**Tests before:** fail(pre-existing scheduler errors)
**Tests after:** pass (8/8 cache tests pass)

## Change
Hoisted `new TextDecoder()` to a module-level constant `_textDecoder`. Every `getManifest` call now reuses the same instance instead of allocating a new one.

## Diff
```diff
+const _textDecoder = new TextDecoder();
 ...
-      const text = new TextDecoder().decode(buf);
+      const text = _textDecoder.decode(buf);
```
