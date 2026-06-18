# Task 010-concurrency-1
**Finding:** Module-level singleton pool has no mutex: concurrent callers can race to create/swap the pool — packages/jxl-pyramid/src/tiled-decode-pool.ts:776-805
**Status:** deferred
**Tests before:** pass(114)
**Tests after:** skipped
## Change
Deferred: `getOrCreatePool` is fully synchronous. JS is single-threaded: no two synchronous code paths can interleave. The first caller creates the pool and assigns `pool = p` before returning; the second caller always sees the already-set `pool`. The factory-swap path sets `pool = null` then immediately (synchronously) assigns `pool = p` at line 840, with no `await` in between. The verified evidence itself notes "JS is single-threaded" and describes the race as a TOCTOU "in the synchronous execution window" — but in single-threaded JS there is no such window. Making `getOrCreatePool` async to add a promise guard would require changing all callers and could introduce actual new races. Deferred pending evidence of a real failure scenario.
