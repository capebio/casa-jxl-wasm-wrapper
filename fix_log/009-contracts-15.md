# Task 009-contracts-15
**Finding:** migrateManifest throws on version > 1 but has no migration path; there is no version negotiation protocol for clients — packages/jxl-progressive/src/progressive-manifest.ts:233-244
**Status:** deferred_adr
**Tests before:** fail(pre-existing)
**Tests after:** skipped (no code change)

## Change
No code change. ADR written to undefined/sections/009/adr_draft/contracts-15-manifest-versioning-strategy.md. Recommends softening the throw to a `console.warn` + attempt-v1-parse in the short term, and server-side version negotiation via `X-JXL-Manifest-Version` header for the long term.
