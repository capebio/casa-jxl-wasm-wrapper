# ADR: Add full-field contract test for Capabilities interface

**Finding:** contracts-8 — No test verifies that all fields of the Capabilities interface are present and typed correctly in the returned object  
**File:** packages/jxl-capabilities/test/tier-matrix.test.ts  
**Status:** deferred_adr

## Context

The `Capabilities` interface declares 18 fields. The tier-matrix tests assert only on `wasm`, `wasmSimd`, `wasmRelaxedSimd`, `selectedWasmBuild`, `sharedArrayBuffer`, and `crossOriginIsolated`. The following fields are never asserted in any test:

- `webgpu`, `webnn`
- `hardwareConcurrency`, `deviceMemory`
- `imageDecoder`, `wasmExceptions`
- `imageBitmap`, `offscreenCanvas`
- `libjxlVersion`
- `wasmThreads`, `nativeJxlDecoder`

TypeScript enforces the shape at compile time, but a runtime smoke test would catch cases where a field silently becomes `undefined` due to a caught exception in a probe (e.g., `_probeWasmExceptions()` throwing unexpectedly and leaving `wasmExceptions` at its initial `false` rather than the correct value).

## Decision Options

**Option A — Structural smoke test in existing suite**  
Add a single test case in `tier-matrix.test.ts` after the existing matrix cases:

```typescript
test("getCapabilities returns all required Capabilities fields with correct types", async () => {
  installProbeStubs({ simd: true });
  const { caps } = await freshCapsAndTier();
  // boolean fields
  for (const key of [
    "wasm", "wasmSimd", "wasmRelaxedSimd", "wasmThreads",
    "crossOriginIsolated", "sharedArrayBuffer", "offscreenCanvas",
    "imageBitmap", "nativeJxlDecoder", "webgpu", "webnn",
    "imageDecoder", "wasmExceptions",
  ] as const) {
    assert.equal(typeof caps[key], "boolean", `caps.${key} must be boolean`);
  }
  assert.equal(typeof caps.hardwareConcurrency, "number");
  assert.ok(caps.deviceMemory === null || typeof caps.deviceMemory === "number");
  assert.equal(typeof caps.libjxlVersion, "string");
  assert.ok(["relaxed-simd-mt","simd-mt","simd","scalar","none"].includes(caps.selectedWasmBuild));
});
```

**Option B — Separate contract test file**  
Add `packages/jxl-capabilities/test/capabilities-contract.test.ts` with the above test plus exhaustive type assertions. Cleaner separation; slightly more overhead.

## Recommendation

Option A. The structural check is three minutes to add and provides full runtime coverage of the Capabilities interface shape. The test is environment-independent (probes are stubbed), so it runs on CI with no additional infrastructure.

## Deferred Because

This is an additive test (no existing behavior changes). The fix is straightforward but requires a deliberate decision about whether `deviceMemory: null` (which `computeCapabilities` can return when `navigator.deviceMemory` is absent) should be asserted as `null` or `number | null`. Deferring to avoid hardcoding the Node.js test environment assumption that `deviceMemory` is always `null`.

## Questions for Owner

1. Should `deviceMemory: null` in Node environments be explicitly tested, or is `typeof null | number` sufficient?
2. Prefer Option A (inline) or Option B (separate file)?
