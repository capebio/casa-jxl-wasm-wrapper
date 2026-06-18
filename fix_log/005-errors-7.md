# Task 005-errors-7
**Finding:** No structured diagnostic channel: all probe failures silently swallowed — packages/jxl-capabilities/src/index.ts:60-83
**Status:** deferred_adr
**Tests before:** pass (9)
**Tests after:** pass (10)

## Change
ADR written to undefined/sections/005/adr_draft/005-errors-7-structured-diagnostic-channel.md. Adding an `onDiagnostic` callback or `setCapabilityDiagnosticListener()` is an API surface addition that requires design approval before implementation.
