# ADR: Replace hand-rolled manifest validation with a schema library (Zod / valibot)

**Finding:** security-4
**File:** packages/jxl-progressive/src/progressive-manifest.ts

## Status
Proposed

## Context

`validateManifest` is a hand-rolled validator that has accumulated multiple confirmed gaps across several review rounds (logic-3, security-2, security-3, contracts-3, contracts-14). Each gap requires a separate assertField call and is easy to miss when adding new fields. A schema library would enforce all constraints (type, range, length, finiteness, structure) in a single declarative definition, closing all current and future gaps at once.

## Options

**Option A — Hand-rolled (status quo):** Continue adding individual `assertField` calls. Low dependency footprint but prone to gaps when schema evolves.

**Option B — Zod:** Popular, well-typed, zero-dependency for validation logic. Adds ~13KB gzipped to bundle. `z.object(...).parse(json)` provides all needed checks. Strong TypeScript inference.

**Option C — valibot:** Smaller than Zod (~2KB gzipped per schema). Modular tree-shaking. Slightly less ergonomic for complex discriminated unions. Growing ecosystem.

**Option D — ajv (JSON Schema):** Standard JSON Schema; good for interop with existing manifest `.json` schema definitions. Larger runtime, harder TypeScript inference.

## Recommendation

**Option C (valibot)** for new code, or keep **Option A** if bundle size is a hard constraint. The `jxl-progressive` package is loaded in browser workers; every byte matters. The current hand-rolled code is ~120 lines — at 2KB overhead valibot is cost-effective. Zod at 13KB is harder to justify.

The migration path is mechanical: define a valibot schema for `ProgressiveManifest`, replace `validateManifest` body with `v.parse(ManifestSchema, json)`, and derive the TypeScript type via `v.InferOutput<typeof ManifestSchema>`.

## Decision factors

| Factor | Hand-rolled | valibot | Zod |
|--------|-------------|---------|-----|
| Bundle size delta | 0 | ~2KB | ~13KB |
| Future-proof against schema gaps | No | Yes | Yes |
| TypeScript inference | Manual | Automatic | Automatic |
| Learning curve for this codebase | None | Low | Low |

## Consequences

- Adopting valibot adds a new runtime dependency; requires package.json update and bundle review.
- All current `assertField` calls can be removed; the schema definition becomes the single source of truth.
- Test changes: existing `ManifestValidationError` is replaced by valibot's `ValiError`; tests must be updated to check the new error type.
- The `ManifestValidationError` class is part of the public API and must be preserved as a wrapper or re-thrown from `validateManifest`.
