# Task 009-errors-6
**Finding:** selectTiers uses totalBytes=0 comparisons without guarding against zero-length input — packages/jxl-progressive/src/progressive-profile.ts:44-60
**Status:** done
**Tests before:** fail(pre-existing TS errors in other files)
**Tests after:** fail(same pre-existing TS errors; no new errors)

## Change
Added `|| totalBytes === 0` to the early-return guard so that a zero-length input always returns a single full tier (with byteEnd=0 matching the actual empty file) without falling through to the dc/preview selection logic. When totalBytes=0, the events array is empty anyway (pushTask loop never executes), so the guard is consistent.

## Diff
```diff
-  if (events.length === 0) {
+  if (events.length === 0 || totalBytes === 0) {
```
