# Task 005-contracts-4
**Finding:** Capabilities.imageDecoder means 'class exists' not 'JXL is supported' — packages/jxl-capabilities/src/index.ts:159-160
**Status:** done
**Tests before:** pass (9)
**Tests after:** pass (10)

## Change
Added a JSDoc comment to the `imageDecoder` field in the `Capabilities` interface that explicitly states it is an API presence check and directs callers to `nativeJxlDecoder` for actual JXL support. No runtime behaviour changed; the semantic ambiguity is resolved at the type-declaration level.

## Diff
```diff
   // Additive platform features (CAP-6 / CAP-8)
+  /** WebCodecs ImageDecoder class exists in this environment. Does NOT imply JXL support — use nativeJxlDecoder for that. */
   imageDecoder: boolean;
```
