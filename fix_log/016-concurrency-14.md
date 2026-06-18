# Task 016-concurrency-14
**Finding:** onSessionEnd callback encodeSessions.delete has the same no-epoch-guard race as concurrency-13 for encode sessions — packages/jxl-worker-browser/src/worker.ts:484-488
**Status:** done
**Tests before:** fail(2) (pre-existing: wasm-loader 404 test + encode hot path test)
**Tests after:** fail(2) (same pre-existing failures; no new failures)
## Change
Added an identity check in the `onSessionEnd` callback for `EncodeHandler`: `if (encodeSessions.get(sessionId) === handler)` before calling `encodeSessions.delete(sessionId)`. Identical fix to concurrency-13 for the encode session map.
## Diff
```diff
-    const handler = new EncodeHandler(msg, wasm, {
-      onSessionEnd: (sessionId) => encodeSessions.delete(sessionId),
-    });
+    const handler = new EncodeHandler(msg, wasm, {
+      onSessionEnd: (sessionId) => {
+        if (encodeSessions.get(sessionId) === handler) encodeSessions.delete(sessionId);
+      },
+    });
```
