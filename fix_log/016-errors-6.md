# Task 016-errors-6

**Finding:** decoder.close() error in feedDecoder is not caught and will propagate as an unhandled rejection from the Promise.all — packages/jxl-worker-browser/src/decode-handler.ts:378-381

**Status:** deferred

**Tests before:** pass (29/29)

**Tests after:** N/A

## Deferral Reason

The `decoder.close()` call is in the finally block of `feedDecoder`, which is awaited in a `Promise.all` inside the try/catch in `run()`. The catch block at line 265 already handles all errors from `Promise.all` including rejection from `decoder.close()`. Adding a `.catch()` would swallow the error and break error reporting. The error handling is already correct—the finding misidentifies this as missing error propagation when it is actually properly captured at the session level.
