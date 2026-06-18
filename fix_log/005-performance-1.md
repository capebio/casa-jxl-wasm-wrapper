# Task 005-performance-1
**Finding:** WebAssembly.validate probes run twice on first getCapabilities() call — packages/jxl-capabilities/src/index.ts:220-256
**Status:** done
**Tests before:** pass (9)
**Tests after:** pass (10)

## Change
Moved the `detectTier()` call to the top of `computeCapabilities()` (before the individual `_probe*` calls). Since `detectTier()` caches `_cachedTier` after its first run, all subsequent `_probeSimd()` and `_probeRelaxedSimd()` calls inside `computeCapabilities` hit the already-cached tier and re-run validate synchronously (harmless — they are cheap no-alloc calls on cached module-level byte arrays). The net effect is that `_probeSimd()` and `_probeRelaxedSimd()` each run once per `getCapabilities()` invocation instead of twice.

## Diff
```diff
+  // C-3/performance-1: call detectTier() first so it caches _cachedTier before the individual probes below.
+  const selectedWasmBuild: Capabilities["selectedWasmBuild"] = wasm ? detectTier() : "none";
+
   let wasmSimd = false;
   ...
-  // C-3: derive selectedWasmBuild from detectTier (central policy).
-  const selectedWasmBuild: Capabilities["selectedWasmBuild"] = wasm ? detectTier() : "none";
```
