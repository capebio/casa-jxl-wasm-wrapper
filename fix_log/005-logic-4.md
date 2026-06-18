# Task 005-logic-4
**Finding:** installProbeStubs stub never returns true for wasmExceptions probe, silently leaving wasmExceptions=false in all matrix tests — packages/jxl-capabilities/test/tier-matrix.test.ts:27-42
**Status:** done
**Tests before:** pass (9/9)
**Tests after:** pass (10/10)

## Change
Added `isEhProbe` fingerprint function that detects PROBE_EH_BYTES via the `0x19` byte (catch_all opcode) which is unique to the EH probe and absent from all other probes. Added `exceptions?: boolean` parameter to `installProbeStubs` (default `false`) and routed the EH probe through it. Added a new matrix test case `"wasm + simd + sab + coi + exceptions probe → wasmExceptions=true"` that exercises the previously-dead path.

## Diff
```diff
+function isEhProbe(view: Uint8Array): boolean {
+  // PROBE_EH_BYTES contains 0x19 (catch_all opcode); not present in any other probe
+  return view.includes(0x19) && !view.includes(0xfd) && !view.includes(0xfe);
+}
+
 function installProbeStubs(options: {
   simd?: boolean;
   relaxed?: boolean;
   threads?: boolean;
+  exceptions?: boolean;
 }) {
-  const { simd = true, relaxed = false, threads = false } = options;
+  const { simd = true, relaxed = false, threads = false, exceptions = false } = options;
   (globalAny.WebAssembly as any).validate = (bytes: BufferSource) => {
     const view = ...;
     if (isThreadProbe(view)) return threads;
     if (isRelaxedProbe(view)) return relaxed;
     if (isSimdProbe(view)) return simd;
+    if (isEhProbe(view)) return exceptions;
     return false;
   };
 }

+  test("wasm + simd + sab + coi + exceptions probe → wasmExceptions=true", async () => {
+    installProbeStubs({ simd: true, relaxed: false, threads: false, exceptions: true });
+    setSAB(true);
+    setCOI(true);
+    const { caps } = await freshCapsAndTier();
+    assert.equal(caps.wasmExceptions, true);
+  });
```
