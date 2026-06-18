# Task 009-security-4
**Finding:** Hand-rolled manifest validation has no numeric-range checks and no maximum-depth guard for nested objects - a Zod/valibot schema would close all current and future gaps at once — packages/jxl-progressive/src/progressive-manifest.ts:99-199
**Status:** deferred_adr
**Tests before:** fail(pre-existing)
**Tests after:** skipped (no code change)

## Change
No code change. ADR written to undefined/sections/009/adr_draft/security-4-schema-validation-library.md. Recommends valibot (2KB) over Zod (13KB) given bundle-size constraints in browser workers; notes that `ManifestValidationError` must be preserved as a public API wrapper around valibot's `ValiError`.
