# ADR: Add detectTier/selectedWasmBuild consistency invariant to tier-matrix tests (logic-6)

**Status:** Draft  
**File:** packages/jxl-capabilities/src/index.ts:89-115  
**Severity:** info

## Context

`detectTier()` and `computeCapabilities()` both derive the WASM tier using identical logic. `computeCapabilities` calls `detectTier()` (after the performance-1 fix) so they are coupled, but the invariant that `caps.selectedWasmBuild === detectTier()` for all probe combinations is never explicitly asserted in the test matrix.

## Decision

Add a single `assert.equal(caps.selectedWasmBuild, tier)` to the `freshCapsAndTier()` helper in `tier-matrix.test.ts`, so the invariant is checked for every existing and future matrix case automatically.

## Implementation

In `packages/jxl-capabilities/test/tier-matrix.test.ts`, in `freshCapsAndTier()`:

```typescript
async function freshCapsAndTier() {
  const mod = await import(`../src/index.js?matrix=${Date.now()}`);
  if (mod && typeof mod._resetCache === "function") {
    mod._resetCache();
  }
  const tier = mod.detectTier();
  const caps = await mod.getCapabilities();
  // Invariant: selectedWasmBuild must always equal detectTier() result.
  assert.equal(caps.selectedWasmBuild, tier, "selectedWasmBuild must equal detectTier()");
  return { mod, tier, caps };
}
```

## Consequences

- All existing 7 matrix tests continue to pass (already consistent post performance-1 fix).
- Any future divergence between `detectTier()` and `computeCapabilities` selectedWasmBuild derivation will fail immediately.
- Zero cost at production runtime — test-only change.
