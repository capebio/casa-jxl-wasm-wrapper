# Task 009-contracts-14
**Finding:** validateManifest does not validate the capture, channels, or channelDescriptors optional fields introduced for Phase 8 — packages/jxl-progressive/src/progressive-manifest.ts:99-198
**Status:** deferred_adr
**Tests before:** fail(pre-existing)
**Tests after:** skipped (no code change)

## Change
No code change. ADR written to undefined/sections/009/adr_draft/contracts-14-phase8-optional-fields-validation.md. Recommends adding structural type guards for the three Phase 8 optional fields without deep-validating nested pose/intrinsics coordinates.
