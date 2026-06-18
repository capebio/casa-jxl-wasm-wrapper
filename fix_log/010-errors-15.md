# Task 010-errors-15
**Finding:** PyramidErrorCode uses open string union, preventing exhaustive handling by callers — packages/jxl-pyramid/src/decode-core.ts:204-229
**Status:** deferred_adr
**Tests before:** pass (114 pass, 0 fail)
**Tests after:** skipped (no code change)

## Change
No code change. The `(string & {})` tail is intentional forward-compatibility design. An ADR was written to document the trade-offs and recommend Option C (introduce `KnownPyramidErrorCode` alias) for when exhaustive handling becomes a priority.

## Diff
```diff
(no diff — adr_draft only)
```

ADR: undefined/sections/010/adr_draft/errors-15-pyramid-error-code-open-union.md
