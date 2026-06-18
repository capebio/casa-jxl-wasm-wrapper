# Task 005-concurrency-4
**Finding:** probeNativeJxl() and probeWebGpuAdapter() have no timeout or AbortSignal — packages/jxl-capabilities/src/index.ts:166-199
**Status:** deferred_adr
**Tests before:** pass (9)
**Tests after:** pass (10)

## Change
ADR written to undefined/sections/005/adr_draft/005-concurrency-4-timeout-abortsignal.md. Adding timeouts requires introducing `setTimeout` usage and selecting timeout values, both of which need benchmarking on real devices before committing to constants. Deferred per CLAUDE.md: "Adaptive/heuristic changes require benchmark data."
