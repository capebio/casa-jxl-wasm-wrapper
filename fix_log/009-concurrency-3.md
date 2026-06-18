# Task 009-concurrency-3
**Finding:** session.push() called fire-and-forget with (session as any).push() — unawaited async call during prefix seeding — packages/jxl-progressive/src/progressive-scheduler.ts:571-573
**Status:** done
**Tests before:** fail(pre-existing)
**Tests after:** fail(2 pre-existing TS2412 only)
## Change
Same as 009-logic-1. The `(session as any)` cast is retained because `push` is not currently on the public `DecodeSession` type visible here; the await ensures the task is not leaked.
## Diff
See 009-logic-1.
