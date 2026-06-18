# Task 009-concurrency-5
**Finding:** Manifest fetch inside startDecode not guarded by AbortSignal: leaks a network request on early abort — packages/jxl-progressive/src/progressive-scheduler.ts:486-505
**Status:** done
**Tests before:** fail(pre-existing)
**Tests after:** fail(2 pre-existing TS2412 only)
## Change
`abort.signal` is now passed to `fetchAndCacheManifest`. Added two abort-signal checks after the async manifest loads so `startDecode` returns early if the job was aborted during manifest fetch, preventing unnecessary decode setup.
## Diff
```diff
-        job.manifest = await this.fetchAndCacheManifest(job);
+        job.manifest = await this.fetchAndCacheManifest(job, abort.signal);
+      if (abort.signal.aborted) return;
```
