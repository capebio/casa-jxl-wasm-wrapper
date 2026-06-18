# Task 010-contracts-004

**Finding:** parsePyramidManifest normalizes schema 1 to 2 but return type declares schema: 1|2 — packages/jxl-pyramid/src/manifest-validate.ts:181-199

**Status:** deferred

**Tests before:** 114 pass, 0 fail

**Tests after:** 114 pass, 0 fail (no code change)

## Rationale

The function already normalizes schema 1 to 2 at runtime (line 182 sets `schema: 2`), but the return type `PyramidManifest` permits both schema 1 and 2. Narrowing the return type would require either:
1. Creating a separate type `PyramidManifestNormalized { schema: 2; ... }`, or
2. Modifying the `PyramidManifest` interface in manifest.ts to constrain schema to 2

This is a type-level design decision that touches the public API. Deferred to QUESTIONS.md for consideration with broader schema versioning strategy.
