# Task 016-concurrency-13
**Finding:** onSessionEnd callback decodeSessions.delete has no epoch guard - a stale handler finishing after release_state+new-start will delete the new handler's map entry — packages/jxl-worker-browser/src/worker.ts:402-406
**Status:** done
**Tests before:** fail(2) (pre-existing: wasm-loader 404 test + encode hot path test)
**Tests after:** fail(2) (same pre-existing failures; no new failures)
## Change
Added an identity check in the `onSessionEnd` callback for `DecodeHandler`: `if (decodeSessions.get(sessionId) === handler)` before calling `decodeSessions.delete(sessionId)`. This prevents a stale handler (whose run() finally fires after release_state + new decode_start for the same sessionId) from deleting the new handler's map entry.
## Diff
```diff
-    const handler = new DecodeHandler(msg, wasm, {
-      onSessionEnd: (sessionId) => decodeSessions.delete(sessionId),
-    });
+    const handler = new DecodeHandler(msg, wasm, {
+      onSessionEnd: (sessionId) => {
+        if (decodeSessions.get(sessionId) === handler) decodeSessions.delete(sessionId);
+      },
+    });
```
