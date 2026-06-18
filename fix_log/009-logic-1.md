# Task 009-logic-1
**Finding:** Prefix push to DecodeSession is not awaited, risking byte-ordering violation — packages/jxl-progressive/src/progressive-scheduler.ts:571-573
**Status:** done
**Tests before:** fail(pre-existing)
**Tests after:** fail(2 pre-existing TS2412 only)
## Change
Added `await` to `(session as any).push(startingPrefix)`. This ensures prefix bytes are fully delivered to the decoder before the subsequent delta fetch begins pushing further bytes, preventing out-of-order codestream delivery.
## Diff
```diff
-        (session as any).push(startingPrefix);
+        await (session as any).push(startingPrefix);
```
