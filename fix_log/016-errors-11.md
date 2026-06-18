# Task 016-errors-11
**Finding:** flushQueuedDecodeMessages and flushQueuedEncodeMessages propagate any synchronous throw from handler methods, crashing the IIFE — packages/jxl-worker-browser/src/worker.ts:206-222
**Status:** done
**Tests before:** fail(2) (pre-existing: wasm-loader 404 test + encode hot path test)
**Tests after:** fail(2) (same pre-existing failures; no new failures)
## Change
Wrapped the routing call inside each flush loop with a try/catch so that a synchronous throw from a handler method does not abort processing of the remaining queued messages. Each message gets a delivery attempt; the exception is silently swallowed (the session is already in a degraded state if a handler throws synchronously).
## Diff
```diff
 function flushQueuedDecodeMessages(sessionId: string, handler: DecodeHandler): void {
   const queue = queuedDecodeMessages.get(sessionId);
   if (queue === undefined) return;
   clearQueuedDecode(sessionId);
   for (const msg of queue) {
-    routeToDecodeHandler(handler, msg);
+    try {
+      routeToDecodeHandler(handler, msg);
+    } catch {
+      // A throw here would leave remaining queued messages unprocessed; swallow
+      // and continue so each queued message gets a delivery attempt.
+    }
   }
 }

 function flushQueuedEncodeMessages(sessionId: string, handler: EncodeHandler): void {
   const queue = queuedEncodeMessages.get(sessionId);
   if (queue === undefined) return;
   clearQueuedEncode(sessionId);
   for (const msg of queue) {
-    routeToEncodeHandler(handler, msg);
+    try {
+      routeToEncodeHandler(handler, msg);
+    } catch {
+      // Same as flushQueuedDecodeMessages — continue on throw.
+    }
   }
 }
```
