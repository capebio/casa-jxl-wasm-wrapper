# Task 010-security-9
**Finding:** Hand-rolled validator duplicates Zod/Valibot pattern without exhaustive numeric-range contracts — packages/jxl-pyramid/src/manifest-validate.ts:1-235
**Status:** deferred_adr
**Tests before:** pass (114)
**Tests after:** pass (114)

## Change
No code edits. Wrote ADR to undefined/sections/010/adr_draft/hand-rolled-validator-vs-schema-library.md documenting three options (keep hand-rolled + extend, Valibot, Zod), recommending Option A short-term with Valibot migration trigger, and cataloguing remaining numeric-range gaps.

## Diff
n/a (ADR only)
