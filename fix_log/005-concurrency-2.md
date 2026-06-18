# Task 005-concurrency-2
**Finding:** Test patches WebAssembly.validate on the shared global before an await without async-scoped isolation, exposing a window where concurrent test infrastructure reads the stub — packages/jxl-capabilities/test/tier.test.ts:26-50
**Status:** done
**Tests before:** pass(2)
**Tests after:** pass(2)
## Change
Moved the `await import(...)` call to before the global stub installation so `WebAssembly.validate` and `WebAssembly.instantiate` are not patched on the global during the import await window. After import, the stubs are installed, `mod._resetCache()` clears the module's cached tier/caps, and `detectTier()` plus `getCapabilities()` run under the stub. `mod._resetCache()` is also called in `finally` to leave the module in a clean state.
## Diff
```diff
-  test("detectTier and selectedWasmBuild ...", async () => {
-    const selfStub = { crossOriginIsolated: false } as any;
-    try {
-      globalAny.self = selfStub;
-      const isThreadProbe = ...;
-      const isRelaxedProbe = ...;
-      const isSimdProbe = ...;
-
-      (WebAssembly as any).validate = ...;
-      (WebAssembly as any).instantiate = ...;
-
-      const mod = await import(`../src/index.js?no-mt=${Date.now()}`);
-      const tier = mod.detectTier();
-      const capabilities = await mod.getCapabilities();
+  test("detectTier and selectedWasmBuild ...", async () => {
+    // Import first so the global stub is not active during the import() await.
+    const mod = await import(`../src/index.js?no-mt=${Date.now()}`);
+
+    const selfStub = { crossOriginIsolated: false } as any;
+    const isThreadProbe = ...;
+    const isRelaxedProbe = ...;
+    const isSimdProbe = ...;
+
+    try {
+      globalAny.self = selfStub;
+      (WebAssembly as any).validate = ...;
+      (WebAssembly as any).instantiate = ...;
+
+      mod._resetCache();
+      const tier = mod.detectTier();
+      const capabilities = await mod.getCapabilities();

       assert.equal(tier, "simd");
       assert.equal(capabilities.selectedWasmBuild, "simd");
     } finally {
       (WebAssembly as any).validate = originalWebAssemblyValidate;
       (WebAssembly as any).instantiate = originalWebAssemblyInstantiate;
       globalAny.self = originalSelf;
+      mod._resetCache();
     }
   });
```
