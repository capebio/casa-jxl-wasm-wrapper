# Task 016-errors-16

**Finding:** waitFor timeout message gives no context about which predicate failed, making test failures hard to diagnose — packages/jxl-worker-browser/test/handlers.test.ts:752-760

**Status:** done

**Tests before:** pass (29/29)

**Tests after:** pass (29/29)

## Change

Added optional `context?: string` parameter to `waitFor()` helper function. When a timeout occurs, the error message now includes the context string if provided, allowing test failures to provide diagnostic information about which predicate failed. The change is backward-compatible since the parameter is optional.

## Diff

```diff
-async function waitFor(predicate: () => boolean): Promise<void> {
+async function waitFor(predicate: () => boolean, context?: string): Promise<void> {
   const started = Date.now();
   while (!predicate()) {
     if (Date.now() - started > 500) {
-      throw new Error("timed out waiting for handler");
+      throw new Error(`timed out waiting for handler${context ? `: ${context}` : ""}`);
     }
     await new Promise((resolve) => setTimeout(resolve, 1));
   }
 }
```
