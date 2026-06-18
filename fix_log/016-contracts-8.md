# Task 016-contracts-8
**Finding:** routeDecodeMessage and routeEncodeMessage silently drop messages for sessions that have already ended — packages/jxl-worker-browser/src/worker.ts:246-262
**Status:** done
**Tests before:** fail(2) (pre-existing: wasm-loader 404 test + encode hot path test)
**Tests after:** fail(2) (same pre-existing failures; no new failures)
## Change
Added an else-if branch in both `routeDecodeMessage` and `routeEncodeMessage`: when a `decode_cancel` / `encode_cancel` arrives for a session that is neither active nor pending (i.e., already ended), a `decode_cancelled` / `encode_cancelled` ack is posted to unblock the scheduler which awaits that response.
## Diff
```diff
 function routeDecodeMessage(msg: QueuedDecodeMessage): void {
   const handler = decodeSessions.get(msg.sessionId);
   if (handler !== undefined) {
     routeToDecodeHandler(handler, msg);
   } else if (pendingDecodeStarts.has(msg.sessionId)) {
     queueDecodeMessage(msg.sessionId, msg);
+  } else if (msg.type === "decode_cancel") {
+    // Session already ended; ack the cancel so the scheduler is not left waiting.
+    self.postMessage({ type: "decode_cancelled", sessionId: msg.sessionId });
   }
 }

 function routeEncodeMessage(msg: QueuedEncodeMessage): void {
   const handler = encodeSessions.get(msg.sessionId);
   if (handler !== undefined) {
     routeToEncodeHandler(handler, msg);
   } else if (pendingEncodeStarts.has(msg.sessionId)) {
     queueEncodeMessage(msg.sessionId, msg);
+  } else if (msg.type === "encode_cancel") {
+    // Session already ended; ack the cancel so the scheduler is not left waiting.
+    self.postMessage({ type: "encode_cancelled", sessionId: msg.sessionId });
   }
 }
```
