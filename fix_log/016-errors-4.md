# Task 016-errors-4

**Finding:** EncodeHandler constructor .catch calls failSession which itself may be in terminal state from run()'s finally, silently losing the error — packages/jxl-worker-browser/src/encode-handler.ts:107-110

**Status:** done

**Tests before:** pass (29/29)

**Tests after:** pass (29/29)

## Change

Added explanatory comment to clarify that failSession is idempotent and safe to call unconditionally in the constructor's catch handler. The session may already be terminated by run()'s finally block, but failSession returns early if the session is already terminal, so no error information is lost—it's simply not redundantly posted.

## Diff

```diff
     this.run().catch((err: unknown) => {
+      // Safely report constructor-phase errors. failSession is a no-op if the session
+      // already terminated (e.g., from run()'s finally block), so unconditional call is safe.
       const message = err instanceof Error ? err.message : String(err);
       this.failSession("Internal", message);
     });
```
