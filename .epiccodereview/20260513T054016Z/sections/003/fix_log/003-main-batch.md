# Fix Log — 003-main-batch (web/main.js)

Date: 2026-05-13  
File: `web/main.js`

---

## 003-err-a1b2c3 [HIGH] — Worker 'error' event leaves task stuck / slot leaked

**Fixed.** Replaced the single `new Worker(…)` block in `init()` with a `_spawnWorker()` helper.  
The new `error` handler:
1. Iterates `this.tasks` to find the task still assigned to the crashed worker and calls its `onError` handler to unblock the caller.
2. Removes the worker from both `this.workers` and `this.free` (it is NOT returned to the free pool).
3. Decrements `this.size` so the pool doesn't wait forever for a slot that will never appear.
4. Dispatches the next queued task with the remaining workers.

---

## 003-logic-a1b2c3 [HIGH] — reprocessLive uses _lastTaskId (wrong for multi-file workers)

**Fixed.** Added `this.workerForTask = new Map()` to the constructor.  
- `_releaseWorker(worker, id)` now sets `this.workerForTask.set(id, worker)` instead of (only) `worker._lastTaskId = id`.
- `reprocessLive(taskId, look)` now does `this.workerForTask.get(taskId)` — exact O(1) lookup regardless of how many tasks a worker has processed.
- `workerForTask` entries are deleted on `done` and `error` to prevent unbounded growth.

---

## 003-perf-a1b2c3 + 003-perf-d4e5f6 [HIGH] — RGB→RGBA expansion on main thread

**Fixed (without touching worker.js).**  
Extracted a `rgbToRgba(rgb, w, h)` helper that uses `Uint32Array` to write all four channels in one 32-bit store per pixel (approximately 4x fewer memory writes than the previous byte-by-byte loop).

`drawCanvas` also now:
- Guards dimension reassignment (`if (canvas.width !== w) canvas.width = w;`).
- Detects if the incoming buffer is already RGBA (`byteLength === w*h*4`) and skips conversion — ready for the worker-side RGBA sending when worker.js is updated.

The `lightbox_live` inline RGB→RGBA loop in the `setLiveHandler` callback was also replaced with a call to `rgbToRgba`.

---

## 003-logic-j0k1l2 [medium] — contrast-boost can push contrast above 1.0

**Fixed.** Wrapped the contrast expression in `Math.max(-1, Math.min(1, …))` in `currentLook()`.

---

## 003-cont-m3n4o5 [medium] — 'error_live' not handled in main thread

**Fixed.** Added an early-return branch at the top of the `setLiveHandler` callback for `msg.type === 'error_live'`:
- Logs a `console.warn`.
- Clears `liveInFlight`.
- Drains `livePendingLook` via `triggerLiveUpdate` so the UI doesn't stall.

---

## 003-conc-d4e5f6 [medium] — liveInFlight not reset on lightbox navigation

**Fixed.** In `nextInLightbox(dir)`, added `liveInFlight = false; livePendingLook = null;` before `drawLightbox()` so the new image starts with clean live-render state.

---

## 003-perf-p6q7r8 [medium] — canvas dimensions reset unconditionally in drawCanvas

**Fixed** as part of the `drawCanvas` rewrite (see perf fix above). Now guarded:
```js
if (canvas.width !== w) canvas.width = w;
if (canvas.height !== h) canvas.height = h;
```

---

## 003-err-j0k1l2 [medium] — JXL Blob URL never revoked

**Fixed.** In `onDone`, before `URL.createObjectURL(blob)`, the code now checks `card._blobUrl` and revokes it if present. The new URL is stored back on `card._blobUrl`.

---

## Lower-severity — applyLookBtn guard (003-logic-s9t0u1)

**Fixed.** When no cards are explicitly selected, `applyLookBtn` now also updates the `.thumb-select` text to `'✓'` and calls `refreshReprocessLabel()` before delegating to `reprocessSelected()`, preventing a visual mismatch where the checkmark dot stays as `·` while the card is actually selected.

---

## Skipped / already correct

- **003-perf-j0k1l2** (triggerGalleryLiveUpdate getAttribute): `c._taskId` was already used — no `getAttribute` call present.
- **003-perf-m3n4o5** (onThumb querySelector caching): Minor; deferred — `querySelector` in hot-ish path but not per-frame.
- **003-conc-j0k1l2**, **003-logic-m3n4o5**, **003-sec-g7h8i9**: Require broader context or touch multiple files; deferred per rules.
