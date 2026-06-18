# Task 009-concurrency-1
**Finding:** prefetchManifest guard races with concurrent startDecode: two fetches may inflate inFlightManifestFetches simultaneously — packages/jxl-progressive/src/progressive-scheduler.ts:427-439
**Status:** done
**Tests before:** fail(pre-existing)
**Tests after:** fail(2 pre-existing TS2412 only)
## Change
`startDecode` now passes `abort.signal` to `fetchAndCacheManifest`, and `fetchAndCacheManifest` checks abort before throwing so the counter is not inflated on abort. The prefetch `.then` handler now also calls `onManifest` if not yet dispatched, closing the race where prefetch result arrived after `manifestDispatched=true` but before `onManifest` fired.
## Diff
```diff
-        job.manifest = await this.fetchAndCacheManifest(job);
+        job.manifest = await this.fetchAndCacheManifest(job, abort.signal);
```
