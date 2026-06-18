# Task 009-errors-13
**Finding:** No error taxonomy / sentinel error types — callers cannot distinguish network, abort, validation, or hash errors programmatically — packages/jxl-progressive/src/progressive-scheduler.ts:703-724
**Status:** deferred_adr
**Tests before:** fail(pre-existing)
**Tests after:** fail(2 pre-existing TS2412 only)
## Change
ADR written to undefined/sections/009/adr_draft/009-errors-13-error-taxonomy.md. Implementing a `ProgressiveLoadError` taxonomy requires changes to the public API surface and an audit of all callers; deferred for a dedicated API-evolution pass.
