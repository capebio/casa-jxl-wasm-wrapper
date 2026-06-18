# Task 016-performance-2

**Finding:** Third performance.now() call on the progress first-pixel path when two timestamps are already in scope — packages/jxl-worker-browser/src/decode-handler.ts:480-484

**Status:** done

**Tests before:** pass (29/29)

**Tests after:** pass (14 decode-handler tests visible)

## Change

Moved `const now = performance.now()` before the `if (!this.firstPixelMetricPosted)` check and replaced the redundant `performance.now()` call inside the check with the reused `now` variable. This eliminates a third timer call on the hot progress path, saving a few microseconds per progress frame in hot decode loops.

## Diff

```diff
          if (transfer.copied) {
            msg.copyMs = tToArray;
            msg.copiedBytes = transfer.buffer.byteLength;
          }
+         const now = performance.now();
          if (!this.firstPixelMetricPosted) {
            this.firstPixelMetricPosted = true;
-           msg.timeToFirstPixelMs = performance.now() - this.stageStartMs;
+           msg.timeToFirstPixelMs = now - this.stageStartMs;
          }
          self.postMessage(msg, [transfer.buffer]);
```
