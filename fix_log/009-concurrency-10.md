# Task 009-concurrency-10
**Finding:** fetchAndCacheManifest has no AbortSignal parameter — no way to cancel in-flight manifest fetch — packages/jxl-progressive/src/progressive-scheduler.ts:727-740
**Status:** deferred_adr
**Tests before:** fail(pre-existing)
**Tests after:** fail(2 pre-existing TS2412 only)
## Change
ADR written to undefined/sections/009/adr_draft/009-concurrency-10-manifest-abort-signal.md. The root fix (adding signal parameter) was implemented as part of 009-concurrency-5/009-errors-7; the ADR documents the design decision and remaining gap (prefetchManifest not yet threaded).
