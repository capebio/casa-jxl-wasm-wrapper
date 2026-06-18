# Task 016-performance-4

**Finding:** maybePostDrain calls performance.now() unconditionally on every invocation, even when the guard will short-circuit — packages/jxl-worker-browser/src/encode-handler.ts:381-400

**Status:** done

**Tests before:** pass (29/29)

**Tests after:** pass (29/29)

## Change

Moved `performance.now()` call inside the drain-allowed guard. The drainAllowed check now short-circuits before computing the timestamp, avoiding an unnecessary timer query when the drain condition is not met. The intervalElapsed check is now computed only after we've confirmed drainAllowed is true.

## Diff

```diff
   private maybePostDrain(): void {
+    // Byte-level secondary gate (mirrors decode-handler): multi-MB pixel chunks
+    // apply byte backpressure even when the chunk count is below CHUNK_HWM.
     const drainAllowed = this.queueDepth < CHUNK_HWM && this.queuedBytes < BYTE_DRAIN_HWM;
 
     const crossedIntoDrain = drainAllowed && !this.lastDrainAllowed;
-    const intervalElapsed = now - this.lastDrainPostedMs >= DRAIN_MIN_INTERVAL_MS;
 
     this.lastDrainAllowed = drainAllowed;
 
     if (!drainAllowed) return;
+
+    const now = performance.now();
+    const intervalElapsed = now - this.lastDrainPostedMs >= DRAIN_MIN_INTERVAL_MS;
 
     if (!crossedIntoDrain && !intervalElapsed) return;
```
