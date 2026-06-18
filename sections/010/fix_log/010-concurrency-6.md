# Task 010-concurrency-6
**Finding:** decodeTiledViewportPooled does not release acquired handles on the empty-handles early-exit path; buffersInFlight also not cleaned — packages/jxl-pyramid/src/tiled-decode-pool.ts:1250-1265
**Status:** deferred
**Tests before:** pass(114)
**Tests after:** skipped
## Change
Deferred: code inspection shows the early-exit returns at lines 1290 and 1298 are inside the outer `try` block (line 1198) whose `finally` (line 1409-1411) runs `buffersInFlight.delete(options.outBuffer)` — so `buffersInFlight` IS cleaned on both paths. The `liveHandles.length === 0` path at line 1290 acquired zero handles so there is nothing to release. The `usable.length === 0` path at line 1296 explicitly calls `p.release(liveHandles)` before returning. The line numbers in the verified.json evidence (1155, 1266, 1383) differ from current code (1198, 1302, 1411), suggesting the finding was based on an earlier version of the file where the try structure was different. No leak exists in current code.
