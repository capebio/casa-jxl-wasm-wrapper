# Task 009-contracts-2
**Finding:** selectTiers may return tiers with byteEnd === 0 when dcEvent.byteOffset is 0 — packages/jxl-progressive/src/progressive-profile.ts:62-105
**Status:** done
**Tests before:** fail(pre-existing TS errors in other files; no new errors in progressive-profile.ts)
**Tests after:** fail(same pre-existing TS errors; no new errors introduced)

## Change
Added a guard `&& dcEvent.byteOffset > 0` to the dc tier push so a dc event at byteOffset 0 is silently dropped rather than producing a ManifestTier with byteEnd=0. The full tier is unaffected.

## Diff
```diff
-  if (dcEvent !== undefined) {
+  // Only emit the dc tier if byteEnd > 0; a zero byteEnd is unusable.
+  if (dcEvent !== undefined && dcEvent.byteOffset > 0) {
```
