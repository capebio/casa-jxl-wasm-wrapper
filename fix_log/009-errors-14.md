# Task 009-errors-14
**Finding:** No default fetch timeout utility — all fetch calls (manifest + tier + full) are unbounded — packages/jxl-progressive/src/progressive-scheduler.ts:730-735
**Status:** deferred_adr
**Tests before:** fail(pre-existing)
**Tests after:** fail(2 pre-existing TS2412 only)
## Change
ADR written to undefined/sections/009/adr_draft/009-errors-14-default-fetch-timeout.md. The manifest timeout is fixed (009-errors-7); tier/full fetch timeout requires a GalleryOptions field and changes in progressive-stream.ts (different file).
