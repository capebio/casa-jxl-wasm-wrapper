# ADR: PyramidErrorCode Open Union vs Exhaustive Taxonomy

**Finding:** errors-15
**File:** packages/jxl-pyramid/src/decode-core.ts:205-222
**Status:** deferred_adr

## Context

`PyramidErrorCode` is defined as a union of known string literals plus `(string & {})`:

```ts
export type PyramidErrorCode =
  | 'ABORTED'
  | 'POOL_DESTROYED'
  | 'FACTORY_CONFLICT'
  | 'TIMEOUT'
  | 'INVALID_REPLY'
  | 'EMPTY_LEVELS'
  | 'BAD_REGION'
  | 'JXTC_PARSE'
  | 'OOM'
  | 'INTERNAL'
  | 'INVALID_BUFFER_SIZE'
  | 'BUFFER_IN_USE'
  | 'BAD_MANIFEST'
  | 'INVALID_BUFFER_ALIGNMENT'
  | 'DECODER_OUTPUT_MISMATCH'
  | 'DIM_MISMATCH'
  | (string & {});
```

The `(string & {})` tail member lets any string be assigned to `PyramidErrorCode` without a cast, which preserves forward-compatibility when new codes are added but prevents TypeScript from flagging unhandled cases in `switch` statements.

## Decision Drivers

1. **Exhaustive handling**: callers that switch on `code` get no compile-time warning when a new known code is added.
2. **Forward-compatibility**: removing the open tail would require every call-site to add a `default:` branch or cast when a new code comes in.
3. **Cross-package boundary**: `PyramidError` is exported from multiple packages (`jxl-pyramid`, `tiled-decode-pool`); a tightening change propagates to all consumers.

## Options Considered

### Option A — Keep `(string & {})` (status quo)
- Pro: zero migration cost; works across package versions without casting.
- Con: no exhaustive-switch safety; lint/type checker cannot flag new unhandled codes.

### Option B — Remove `(string & {})`, require explicit `default:`
- Pro: TypeScript enforces exhaustive handling in switch.
- Con: breaks existing `switch (err.code)` call-sites that rely on widening; every consumer must add `default:`.

### Option C — Introduce `UnknownPyramidErrorCode` alias
```ts
export type KnownPyramidErrorCode =
  | 'ABORTED' | 'POOL_DESTROYED' | /* ... */ | 'DIM_MISMATCH';

export type UnknownPyramidErrorCode = string & {};

export type PyramidErrorCode = KnownPyramidErrorCode | UnknownPyramidErrorCode;
```
Callers that want exhaustive handling can narrow to `KnownPyramidErrorCode`; others keep `PyramidErrorCode`.

- Pro: opt-in exhaustive handling without breaking existing consumers.
- Con: two types to maintain; requires callers to know which type to use.

### Option D — `satisfies` guard in test
Add a test-only exhaustive check via `satisfies` or a never-falling-through helper that asserts all known codes are handled, without changing the exported type.

- Pro: catches regressions at test time without migrating call-sites.
- Con: only protects the test file, not consumer code.

## Recommendation

**Option C** (introduce `KnownPyramidErrorCode`) is the lowest-risk path to exhaustive-handling capability. It is a purely additive change — existing consumers keep using `PyramidErrorCode`; new consumers that want compile-time safety narrow to `KnownPyramidErrorCode`.

Implementation is two lines in decode-core.ts plus one re-export in each package's `index.ts`. No call-site migration required.

## Decision

Deferred to the owner. The current `(string & {})` pattern is intentional (forward-compat), but Option C is available whenever exhaustive handling becomes a priority.
