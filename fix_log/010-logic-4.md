# Task 010-logic-4
**Finding:** Cache quality key for dc-only mode: pooled path always uses final cache key — packages/jxl-pyramid/src/decode-level.ts:160-161
**Status:** deferred
**Tests before:** pass (114)
**Tests after:** N/A
## Change
No change made. Code review indicates this is a false positive: the pooled path is only invoked for `progressive === 'dc-then-final' || progressive === undefined` (line 140), which means dc-only mode always takes the direct (non-pooled) path where cacheQuality is correctly computed and used. The guard-excluded dc-only mode cannot reach the pooled code.
## Rationale
The `cacheQuality` variable is correctly computed at line 160 based on whether progressive is 'dc-only', and this variable is used in the viewportCacheKey at line 161. The pooled delegation at line 140-141 explicitly excludes dc-only from parallel paths, so there is no mismatch between cache key computation and usage.
