# Task 016-performance-5
**Finding:** No throughput or allocation benchmark for the decode/encode handler hot paths — packages/jxl-worker-browser/test/handlers.test.ts:1-30
**Status:** done
**Tests before:** pass(28), fail(1) — pre-existing wasm-loader failure; tsc clean
**Tests after:** tsc clean for handlers.test.ts (0 errors); both benchmark tests pass in isolation; combined dist-test run blocked by pre-existing worker.ts TS errors introduced by another agent (WORKER_PROTOCOL_VERSION not yet exported from jxl-core/protocol)

## Change
Added two benchmark/regression-guard tests inside the existing `describe("browser codec handlers")` block:

1. **decode handler hot path** — drives 200 progress frames through `DecodeHandler` with a 2-second budget. Asserts all 200 `decode_progress` messages arrive and the total elapsed time stays under budget. Catches catastrophic allocation regressions in the `toTransferablePixels` / `postMetric` / `assignFrameMeta` hot path.

2. **encode handler hot path** — pushes 200 pixel chunks through `EncodeHandler` with a 2-second budget. Asserts the session completes within budget and at least one `worker_drain` message was posted (confirming the drain coalescing path was exercised). Catches regressions in `onPixels` per-call allocation and `maybePostDrain`.

Both tests pass in isolation (`node --test --test-name-pattern`). The combined run failure is a stale-dist-test artifact: another agent's edits to `src/worker.ts` (adding `WORKER_PROTOCOL_VERSION` import) created TS errors that break `npm test`'s tsc step, so the dist-test directory contains a mix of partially-compiled files. This is unrelated to the benchmark additions.

## Diff
```diff
--- a/packages/jxl-worker-browser/test/handlers.test.ts
+++ b/packages/jxl-worker-browser/test/handlers.test.ts
@@ -734,6 +734,96 @@
     expect(ended).toEqual(["deferred-release-test"]);
   });
 
+  test("decode handler hot path: N progress frames complete within time budget (allocation regression guard)", async () => {
+    const FRAME_COUNT = 200;
+    const BUDGET_MS = 2000;
+    const messages: WorkerToMainMessage[] = [];
+    const ended: string[] = [];
+    installWorkerPostMessage(messages);
+
+    const info = {
+      width: 4, height: 4, bitsPerSample: 8,
+      hasAlpha: true, hasAnimation: false, jpegReconstructionAvailable: false,
+    };
+    const pixels = new Uint8Array(4 * 4 * 4).buffer;
+
+    const codec = {
+      createDecoder() {
+        return {
+          push() {},
+          close() {},
+          cancel() {},
+          dispose() {},
+          async *events() {
+            yield { type: "header", info };
+            for (let i = 0; i < FRAME_COUNT; i++) {
+              yield {
+                type: "progress",
+                stage: "dc" as const,
+                info,
+                pixels,
+                format: "rgba8" as const,
+                pixelStride: 4,
+              };
+            }
+            yield { type: "final", info, pixels, format: "rgba8" as const, pixelStride: 4 };
+          },
+        };
+      },
+    };
+
+    const t0 = performance.now();
+    const handler = new DecodeHandler(
+      { ...baseDecodeStart, sessionId: "bench-decode-progress" },
+      codec as never,
+      { onSessionEnd: (sessionId) => ended.push(sessionId) },
+    );
+    handler.onChunk(new Uint8Array([0xff]).buffer);
+    handler.onClose();
+
+    await waitFor(() => ended.length === 1);
+    const elapsed = performance.now() - t0;
+
+    const progressCount = messages.filter((m) => m.type === "decode_progress").length;
+    expect(progressCount).toBe(FRAME_COUNT);
+    if (elapsed >= BUDGET_MS) {
+      throw new Error(`decode progress hot path took ${elapsed.toFixed(1)} ms for ${FRAME_COUNT} frames (budget ${BUDGET_MS} ms) — possible allocation regression`);
+    }
+  });
+
+  test("encode handler hot path: N pixel chunks complete within time budget (allocation regression guard)", async () => {
+    const CHUNK_COUNT = 200;
+    const BUDGET_MS = 2000;
+    const messages: WorkerToMainMessage[] = [];
+    const ended: string[] = [];
+    installWorkerPostMessage(messages);
+
+    const codec = {
+      createEncoder() {
+        return {
+          pushPixels() {},
+          finish() {},
+          cancel() {},
+          dispose() {},
+          async *chunks() {
+            yield new Uint8Array([0]).buffer;
+          },
+        };
+      },
+    };
+
+    const t0 = performance.now();
+    const handler = new EncodeHandler(
+      { ...baseEncodeStart, sessionId: "bench-encode-pixels" },
+      codec as never,
+      { onSessionEnd: (sessionId) => ended.push(sessionId) },
+    );
+    for (let i = 0; i < CHUNK_COUNT; i++) {
+      handler.onPixels(new Uint8Array([i & 0xff, 0, 0, 255]).buffer);
+    }
+    handler.onFinish();
+
+    await waitFor(() => ended.length === 1);
+    const elapsed = performance.now() - t0;
+
+    if (elapsed >= BUDGET_MS) {
+      throw new Error(`encode pixel hot path took ${elapsed.toFixed(1)} ms for ${CHUNK_COUNT} chunks (budget ${BUDGET_MS} ms) — possible allocation regression`);
+    }
+    const drainCount = messages.filter((m) => m.type === "worker_drain").length;
+    expect(drainCount).toBeGreaterThan(0);
+  });
 });
```
