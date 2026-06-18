# Task 005-errors-8
**Finding:** No shared withTimeout utility — two async probes independently need timeout protection — packages/jxl-capabilities/src/index.ts:203-277
**Status:** deferred_adr
**Tests before:** pass (9)
**Tests after:** pass (10)

## Change
ADR written to undefined/sections/005/adr_draft/005-errors-8-shared-timeout-utility.md. Implements the timeout pattern for both probeNativeJxl and probeWebGpuAdapter. Deferred alongside concurrency-4 since both require agreeing on timeout constants.
