# Task 009-security-2
**Finding:** validateManifest does not reject negative, non-finite, or inverted byteStart/byteEnd values in tier entries — packages/jxl-progressive/src/progressive-manifest.ts:183-196
**Status:** done
**Tests before:** fail(pre-existing)
**Tests after:** fail(same pre-existing; tsc on progressive-manifest.ts clean)

## Change
Implemented as part of 009-contracts-3. `Number.isFinite` guards on both byteStart and byteEnd reject NaN, Infinity, -Infinity. The `>= 0` guard on byteStart and `> 0` guard on byteEnd reject negative values. See 009-contracts-3.md diff.
