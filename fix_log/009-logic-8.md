# Task 009-logic-8
**Finding:** No-manifest fallback sets currentTier to targetTier (may skip tiers) — packages/jxl-progressive/src/progressive-scheduler.ts:664-665
**Status:** done
**Tests before:** fail(pre-existing)
**Tests after:** fail(2 pre-existing TS2412 only)
## Change
Same as 009-contracts-4. `achieved` is now always `target` (one step up from `currentTier`), preventing tier jumps when no manifest is available.
## Diff
See 009-contracts-4.
