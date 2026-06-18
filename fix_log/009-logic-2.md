# Task 009-logic-2
**Finding:** Relation, CameraPose, FrameSetMember, FrameSet, BurstGroup, defaultComposeBurstFrame, getSharpnessRank, argmaxSharpness are declared twice in the same file — packages/jxl-progressive/src/types.ts:119-401
**Status:** done
**Tests before:** fail(2)
**Tests after:** fail(2)
## Change
No edit needed: the finding (and its corroborating dependency contracts-1) describes a verbatim Phase-8 duplicate block at lines ~263-411, but the current `types.ts` is only 316 lines and each symbol (`Relation`, `FrameRole`, `CameraPose`, `FrameSetMember`, `FrameSet`, `BurstGroup`, `ComposeBurstFrame`, `defaultComposeBurstFrame`, `getSharpnessRank`, `argmaxSharpness`) is declared exactly once. The duplicate block was already collapsed (by dependency `009-contracts-1`, the same duplication finding from the contracts detector, or shipped without it). `tsc` emits zero duplicate-identifier errors for `types.ts`, confirming the condition is resolved.
The 2 pre-existing `tsc` failures are `TS2412` in `progressive-scheduler.ts` (lines 260, 384) — a different file, unrelated to this finding, and out of scope for this task. They are present both before and after.
## Diff
```diff
(no change — duplicate block already absent from packages/jxl-progressive/src/types.ts)
```
