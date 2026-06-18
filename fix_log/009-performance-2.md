# Task 009-performance-2
**Finding:** tierRank() called 4 times per job per tick — packages/jxl-progressive/src/progressive-scheduler.ts:471-478
**Status:** done
**Tests before:** fail(pre-existing)
**Tests after:** fail(2 pre-existing TS2412 only)
## Change
`tierRank` is now called once per job (currentTier and targetTier each once) inside the single-pass for-of loop introduced by performance-1. Previously called 4× per job across chained filters.
## Diff
See performance-1 diff.
