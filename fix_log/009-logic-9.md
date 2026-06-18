# Task 009-logic-9
**Finding:** No cross-tier ordering invariant: tiers array could list dc with byteEnd > preview's byteEnd — packages/jxl-progressive/src/progressive-manifest.ts:199-244
**Status:** deferred_adr
**Tests before:** fail(pre-existing)
**Tests after:** skipped (no code change)

## Change
No code change. ADR written to undefined/sections/009/adr_draft/logic-9-cross-tier-ordering-invariant.md. Recommends adding uniqueness check + pairwise byteEnd ordering assertions after the per-tier loop.
