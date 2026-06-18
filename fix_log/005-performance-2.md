# Task 005-performance-2
**Finding:** Individual probe results not cached at module level — packages/jxl-capabilities/src/index.ts:60-82
**Status:** deferred_adr
**Tests before:** pass (9)
**Tests after:** pass (10)

## Change
ADR written to undefined/sections/005/adr_draft/005-performance-2-probe-result-caching.md. The hot-path double-probe is already resolved by 005-performance-1; per-probe caching is defence-in-depth for edge cases.
