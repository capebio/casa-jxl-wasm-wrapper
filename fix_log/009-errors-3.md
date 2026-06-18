# Task 009-errors-3
**Finding:** session.push() call for prefix bytes is fire-and-forget — rejection is never awaited or caught — packages/jxl-progressive/src/progressive-scheduler.ts:571-573
**Status:** done
**Tests before:** fail(pre-existing)
**Tests after:** fail(2 pre-existing TS2412 only)
## Change
Same as 009-logic-1: `await` added. A rejected push now propagates to the enclosing `startDecode` try/catch, which dispatches `onError` and arms the retry timer.
## Diff
See 009-logic-1.
