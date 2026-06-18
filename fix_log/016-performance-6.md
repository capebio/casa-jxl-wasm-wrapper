# Task 016-performance-6

**Finding:** compactQueue called after every takeNextPixels even when no compaction threshold is met — packages/jxl-worker-browser/src/encode-handler.ts:307-315

**Status:** done

**Tests before:** pass (29/29)

**Tests after:** pass (29/29)

## Change

Renamed `compactQueue()` to `maybeCompactQueue()` and moved the compaction call to only execute after a valid entry is dequeued (when stats are updated). The call was removed from the undefined entry path, avoiding redundant threshold checks when the queue slot is empty.

## Diff

```diff
   private takeNextPixels(): { chunk: ArrayBuffer; region?: Region } | null {
     const entry = this.pixelQueue[this.pixelReadIndex];
     this.pixelQueue[this.pixelReadIndex++] = undefined;
     if (entry === undefined) {
-      this.compactQueue();
       return null;
     }
     this.queueDepth--;
     this.queuedBytes -= entry.chunk.byteLength;
-    this.compactQueue();
+    this.maybeCompactQueue();
     return entry;
   }
 
-  private compactQueue(): void {
+  private maybeCompactQueue(): void {
     if (this.pixelReadIndex >= this.pixelQueue.length) {
       this.pixelQueue.length = 0;
       this.pixelReadIndex = 0;
     } else if (this.pixelReadIndex > 64 && this.pixelReadIndex * 2 > this.pixelQueue.length) {
       this.pixelQueue.copyWithin(0, this.pixelReadIndex);
       this.pixelQueue.length -= this.pixelReadIndex;
       this.pixelReadIndex = 0;
     }
   }
```
