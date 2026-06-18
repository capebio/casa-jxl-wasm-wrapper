# Task 009-logic-3
**Finding:** validateManifest does not check byteEnd > byteStart for tiers, allowing zero-length or inverted ranges — packages/jxl-progressive/src/progressive-manifest.ts:183-196
**Status:** done
**Tests before:** fail(pre-existing)
**Tests after:** fail(same pre-existing; tsc on progressive-manifest.ts clean)

## Change
Implemented as part of 009-contracts-3. The `byteEnd > byteStart` assertField was added in the tier validation loop alongside the finite/non-negative/positive checks.

## Diff
See 009-contracts-3.md — same diff.
