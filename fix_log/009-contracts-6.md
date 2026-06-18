# Task 009-contracts-6
**Finding:** session.push(startingPrefix) is called with (session as any).push(), bypassing the DecodeSession type and ignoring the returned Promise — packages/jxl-progressive/src/progressive-scheduler.ts:571-573
**Status:** done
**Tests before:** fail(pre-existing)
**Tests after:** fail(2 pre-existing TS2412 only)
## Change
Added `await`. The `(session as any)` cast is not removed because `push` is not exposed on the `SessionFactory` return type in the current type definitions; removing the cast would require a type-level change in a different file (out of scope).
## Diff
See 009-logic-1.
