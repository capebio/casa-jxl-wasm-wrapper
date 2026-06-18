# Task 009-contracts-9
**Finding:** prefetchManifest races with startDecode: prefetch result may arrive after manifestDispatched is already true — packages/jxl-progressive/src/progressive-scheduler.ts:427-439
**Status:** done
**Tests before:** fail(pre-existing)
**Tests after:** fail(2 pre-existing TS2412 only)
## Change
The prefetch `.then` handler now calls `onManifest` if the manifest arrived and `!job.manifestDispatched`, closing the race where the manifest was stored but never dispatched because `startDecode` had already set `manifestDispatched=true`.
## Diff
See 009-errors-1 diff (same code block).
