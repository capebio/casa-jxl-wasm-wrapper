# Task 010-logic-6
**Finding:** decodeTilesParallel total progress count is halved for dc-only progressive mode — packages/jxl-pyramid/src/tiled-decode-pool.ts:926-927
**Status:** deferred
**Tests before:** pass(114)
**Tests after:** skipped
## Change
Deferred: verdict is "uncertain" in verified.json. The dc-only pooled path is excluded by the `parallelEligible` guard in decode-level.ts:139 (`progressive === 'dc-then-final' || progressive === undefined`), so dc-only never reaches `decodeTilesParallel` without an explicit `progressTotal`. All callers that set `progressiveStage='dc'` also pass `progressTotal` explicitly, so the default expression is never reached with a dc-only stage in production. Changing the multiplier logic risks breaking the dc-then-final dual-pass accounting where `tiles.length * 2` is correct.
