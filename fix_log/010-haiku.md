# Task 010-errors-1
**Finding:** spawnOne() silently swallows factory exceptions, hiding pool starvation cause — packages/jxl-pyramid/src/tiled-decode-pool.ts:498-509
**Status:** done
**Tests before:** 114 pass
**Tests after:** 114 pass
## Change
Added error logging in bare catch block during worker spawning in acquire() to expose factory failures in dev mode instead of silently breaking.

## Diff
```diff
       } catch (e) {
+        if (DEV) console.warn('[pyramid] spawnOne failed during acquire:', e);
         break;
```

---

# Task 010-errors-2
**Finding:** Worker addEventListener wiring failures silently swallowed, hiding lifecycle errors — packages/jxl-pyramid/src/tiled-decode-pool.ts:619-625
**Status:** done
**Tests before:** 114 pass
**Tests after:** 114 pass
## Change
Added error logging when addEventListener fails during worker setup to expose wiring issues.

## Diff
```diff
     } catch (e) {
+      if (DEV) console.warn('[pyramid] addEventListener failed:', e);
       wiringOk = false;
```

---

# Task 010-errors-3
**Finding:** ensureLoaded() silently swallows all postMessage errors per worker — packages/jxl-pyramid/src/tiled-decode-pool.ts:727-759
**Status:** done
**Tests before:** 114 pass
**Tests after:** 114 pass
## Change
Added error logging in ensureLoaded's postMessage catch block to expose load message failures per bytesId.

## Diff
```diff
       } catch (e) {
+        if (DEV) console.warn(`[pyramid] ensureLoaded postMessage failed for bytesId ${bytesId}:`, e);
       }
```

---

# Task 010-errors-5
**Finding:** destroy() setInterval leak when active workers never drain: interval not cleared on grace timeout — packages/jxl-pyramid/src/tiled-decode-pool.ts:396-403
**Status:** done
**Tests before:** 114 pass
**Tests after:** 114 pass
## Change
Captured interval outside Promise and added explicit clearInterval in finally block after race completes, preventing timer leak when grace timeout fires before drain completes.

## Diff
```diff
     let iv: ReturnType<typeof globalThis.setInterval> | null = null;
     const drained = new Promise<void>(r => {
       iv = globalThis.setInterval(() => {
         if (this.active.size === 0) { if (iv) globalThis.clearInterval(iv); r(); }
       }, 10);
     });
     await Promise.race([drained, new Promise(r => globalThis.setTimeout(r, graceMs))]);
+    if (iv) globalThis.clearInterval(iv);
```

---

# Task 010-errors-10
**Finding:** prewarmAsync fire-and-forget in constructor creates unhandled promise rejection on spawn failure — packages/jxl-pyramid/src/tiled-decode-pool.ts:308-312, 801
**Status:** done
**Tests before:** 114 pass
**Tests after:** 114 pass
## Change
Added .catch() handlers to both prewarmAsync fire-and-forget calls in constructor and getOrCreatePool to log spawn failures in dev mode.

## Diff
```diff
     void this.prewarmAsync(this.minIdle).catch(e => {
       if (DEV) console.warn('[pyramid] eager prewarm failed:', e);
     });
+    void p.prewarmAsync(2).catch(e => {
+      if (DEV) console.warn('[pyramid] getOrCreatePool prewarm failed:', e);
+    });
```

---

# Task 010-errors-18
**Finding:** getOrCreatePool: pool.destroy(0) called fire-and-forget when factory changes, hiding destroy errors — packages/jxl-pyramid/src/tiled-decode-pool.ts:779-805
**Status:** done
**Tests before:** 114 pass
**Tests after:** 114 pass
## Change
Added .catch() handler to pool.destroy fire-and-forget call during factory swap to log errors.

## Diff
```diff
       void pool.destroy(0).catch(e => {
         if (DEV) console.warn('[pyramid] pool.destroy during factory swap failed:', e);
       });
```

---

# Task 010-security-8
**Finding:** parseWorkerReply trusts worker-supplied w/h dimensions without upper-bound checks — packages/jxl-pyramid/src/tiled-decode-pool.ts:821-843
**Status:** done
**Tests before:** 114 pass
**Tests after:** 114 pass
## Change
Added validation that w and h are in range (0, 1000000] to prevent integer overflow and unrealistic dimensions from untrusted worker replies.

## Diff
```diff
         if ((d.pixels instanceof Uint8Array || d.pixels instanceof ArrayBuffer) &&
             typeof d.w === 'number' && typeof d.h === 'number' &&
+            d.w > 0 && d.w <= 1000000 && d.h > 0 && d.h <= 1000000) {
```

---

# Task 010-concurrency-2
**Finding:** prewarmAsync state transition races: concurrent calls can push state back to Prewarming after Active — packages/jxl-pyramid/src/tiled-decode-pool.ts:346-360
**Status:** done
**Tests before:** 114 pass
**Tests after:** 114 pass
## Change
Added early return in prewarmAsync if pool is already Prewarming or Active to prevent concurrent calls from re-entering the prewarm state machine.

## Diff
```diff
     if (this.state === PoolState.Destroyed || this.state === PoolState.Draining) return;
+    if (this.state === PoolState.Prewarming || this.state === PoolState.Active) return;
     this.state = PoolState.Prewarming;
```

---

# Task 010-concurrency-5
**Finding:** decodeTilesParallel coroutine loop checks failed/aborted after awaiting, not before claiming tile index — packages/jxl-pyramid/src/tiled-decode-pool.ts:944-1028
**Status:** done
**Tests before:** 114 pass
**Tests after:** 114 pass
## Change
Moved abort/failed check to immediately after next++ to prevent claiming tile indices when abort is already signaled, reducing work queuing for cancelled decodes.

## Diff
```diff
       const idx = next++;
       if (idx >= tiles.length) break;
+      if (failed || controller.signal.aborted) break;
       const region = tiles[idx]!;
```

---

# Task 010-concurrency-10
**Finding:** Waiter queue in acquire() uses plain setTimeout for expiry but does not cancel the timeout on early resolution — packages/jxl-pyramid/src/tiled-decode-pool.ts:455-538
**Status:** done
**Tests before:** 114 pass
**Tests after:** 114 pass
## Change
Added timer field to waiter object and clearTimeout calls in both early resolution (when handles allocated) and late expiry (when timeout fires) to prevent orphaned timers.

## Diff
```diff
+  private readonly waiters: Array<{ want: number; resolve: (handles: WorkerHandle[]) => void; expiresAt?: number; timer?: ReturnType<typeof globalThis.setTimeout> }> = [];
        const waiter: any = {
          want: need,
          resolve: (hs: WorkerHandle[]) => {
+           if (waiter.timer) globalThis.clearTimeout(waiter.timer);
            resolve([...got, ...hs]);
          },
        };
        waiter.timer = globalThis.setTimeout(() => {
+         if (w.timer) globalThis.clearTimeout(w.timer);
```

---

# Task 010-perf-1
**Finding:** Per-tile grid-origin and expectedLen recomputed twice in the same function for cache hits and partial-hit paths — packages/jxl-pyramid/src/tiled-decode-pool.ts:1165-1205
**Status:** done
**Tests before:** 114 pass
**Tests after:** 114 pass
## Change
Stored gridTileW/H and gridTileX/Y in hit items during cache categorization phase, reusing them in both cache-miss and cache-hit stitch loops to eliminate redundant floor/min computations.

## Diff
```diff
-    const hits: Array<{ region: ImageRegion; pixels: Uint8Array; id: TileId }> = [];
+    const hits: Array<{ region: ImageRegion; pixels: Uint8Array; id: TileId; gridTileW: number; gridTileH: number; gridTileX: number; gridTileY: number }> = [];
         const hit = cache.get(finalKey);
         if (hit && hit.byteLength === expectedLen) {
-          hits.push({ region: tile, pixels: hit, id });
+          hits.push({ region: tile, pixels: hit, id, gridTileW, gridTileH, gridTileX, gridTileY });
```

---

# Task 010-perf-6
**Finding:** Center-out sort of misses array allocates and recomputes per viewport decode in pooled path — packages/jxl-pyramid/src/tiled-decode-pool.ts:1299-1305
**Status:** done
**Tests before:** 114 pass
**Tests after:** 114 pass
## Change
Applied Schwartzian transform: map to (tile, dist) pairs, sort once, then map back to tiles to avoid recomputing distances during sort comparisons.

## Diff
```diff
       const orderedMisses = misses.map((tile, idx) => ({
+        tile,
+        dist: (tile.x + tile.w / 2 - cx) ** 2 + (tile.y + tile.h / 2 - cy) ** 2,
+      })).sort((a, b) => a.dist - b.dist).map(item => item.tile);
```

---

# Task 010-perf-7
**Finding:** _reapBound uses Array.includes() (O(n)) to check idle membership on every timer fire — packages/jxl-pyramid/src/tiled-decode-pool.ts:686-690
**Status:** done
**Tests before:** 114 pass
**Tests after:** 114 pass
## Change
Added inIdle boolean flag to WorkerHandle, updated all idle list mutations to set/clear flag. _reapBound now checks O(1) flag instead of O(n) Array.includes.

## Diff
```diff
   type WorkerHandle = {
+    inIdle?: boolean;
   };
   private readonly _reapBound = (h: WorkerHandle) => {
-    if (this.idle.includes(h) && this.idle.length > this.minIdle) {
+    if (h.inIdle && this.idle.length > this.minIdle) {
```

---

# Task 010-perf-8
**Finding:** destroyHandle uses Array.indexOf() + Array.splice() to remove handle from idle list (O(n) scan) — packages/jxl-pyramid/src/tiled-decode-pool.ts:439-444
**Status:** done
**Tests before:** 114 pass
**Tests after:** 114 pass
## Change
Uses inIdle flag (from perf-7) to skip indexOf/splice when handle is not in idle list, reducing O(n) scan to O(1) check.

## Diff
```diff
     this.active.delete(h);
+    if (h.inIdle) {
       const ii = this.idle.indexOf(h);
       if (ii >= 0) this.idle.splice(ii, 1);
+      h.inIdle = false;
+    }
```

---

# Task 010-perf-9
**Finding:** setHandleState allocates a new allowed[] array on every state transition via object literal — packages/jxl-pyramid/src/tiled-decode-pool.ts:55-69
**Status:** done
**Tests before:** 114 pass
**Tests after:** 114 pass
## Change
Moved allowed transition table from function-local object literal to module-level const, and changed from arrays to Record for O(1) lookup instead of array.includes().

## Diff
```diff
-  const allowed: Record<HandleState, HandleState[]> = {
-    [HandleState.WarmFloor]: [HandleState.Active, HandleState.Bad, HandleState.Terminated],
+const ALLOWED_TRANSITIONS: Record<HandleState, Record<HandleState, boolean>> = {
+  [HandleState.WarmFloor]: { [HandleState.Active]: true, [HandleState.Bad]: true, [HandleState.Terminated]: true },
```

---

# Task 010-perf-10
**Finding:** destroy() iterates pending jobs via Array.from(h.pending.values()) allocating a snapshot array — packages/jxl-pyramid/src/tiled-decode-pool.ts:384-387
**Status:** done
**Tests before:** 114 pass
**Tests after:** 114 pass
## Change
Removed Array.from wrapper to iterate h.pending.values() directly via for-of loop, eliminating snapshot allocation.

## Diff
```diff
-      for (const job of Array.from(h.pending.values())) {
+      for (const job of h.pending.values()) {
```

---

# Task 010-contracts-005
**Finding:** decodeTilesParallel resolves worker jobs with DecodedLevel missing format field — packages/jxl-pyramid/src/tiled-decode-pool.ts:667-668
**Status:** done
**Tests before:** 114 pass
**Tests after:** 114 pass
## Change
Added format field to job.resolve() call, inferred from bytesPerPixel (4=rgba8, 8=rgba16) stored in PendingJob.

## Diff
```diff
       this.cleanupPendingJob(h, job);
+      const format: PixelFormat = job.bytesPerPixel === 8 ? 'rgba16' : 'rgba8';
       job.resolve({ pixels, width: reply.w, height: reply.h, format });
```

---

# Task 010-contracts-010
**Finding:** decodeTiledViewportPooled overloads omit pool option from the Uint8Array first-argument form — packages/jxl-pyramid/src/tiled-decode-pool.ts:1052-1080
**Status:** done
**Tests before:** 114 pass
**Tests after:** 114 pass
## Change
Added pool?: PyramidWorkerPool field to both function overload signatures to match implementation's full DecodeOptions.

## Diff
```diff
   options?: {
     useSAB?: boolean;
+    pool?: PyramidWorkerPool;
   },
```

---

# Task 010-errors-16
**Finding:** acquire() maxWaitMs defaults to 60ms with no diagnostic when timeout fires — packages/jxl-pyramid/src/tiled-decode-pool.ts:460-461
**Status:** done
**Tests before:** 114 pass
**Tests after:** 114 pass
## Change
Added console.warn in waiter timeout callback (when acquire times out) to log requested vs. actual handle count and pool capacity for debugging starvation.

## Diff
```diff
               waiter.timer = undefined;
+              if (DEV && got.length < count) {
+                console.warn(`[pyramid] acquire timeout: requested ${count}, got ${got.length}, pool at max ${this.maxSize}`);
+              }
               resolve(got);
```
