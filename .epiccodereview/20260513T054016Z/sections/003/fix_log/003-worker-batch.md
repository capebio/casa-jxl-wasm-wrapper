# Fix Log — 003-worker-batch (web/worker.js)

File modified: `web/worker.js`

---

## 003-conc-a1b2c3 [HIGH] — reprocess_live used module-level liveState

**Problem**: The `reprocess_live` handler read from the module-level `liveState` variable, which always pointed to the most-recently processed file. On a worker that handles multiple files, a `reprocess_live` for file A would incorrectly use state from file B if B was processed after A.

**Fix**:
- Removed the `let liveState = null` module-level variable.
- Updated `reprocess_live` handler to look up state via `liveStateMap.get(id)`.
- Updated the pipeline's liveState storage from `liveState = makeLiveState(…); liveStateMap.set(id, liveState)` to `liveStateMap.set(id, makeLiveState(…))` directly.

---

## 003-err-d4e5f6 [HIGH] — WASM init failure caches rejected promise

**Problem**: If `init()` threw, `wasmReady` retained the rejected promise. Every subsequent call to `ensureWasm()` would re-await that same rejected promise and fail permanently, requiring a worker restart.

**Fix**: Added try/catch in `ensureWasm()`. On failure, sets `wasmReady = null` before re-throwing, allowing the next call to retry initialization.

---

## 003-cont-a1b2c3 [medium] — Unknown message types fell through to pipeline

**Problem**: Any unrecognised message type that didn't match `reprocess_live` or `reprocess_thumb_live` fell into the full ORF pipeline block. Destructuring `{ id, bytes, options }` from a message that doesn't have those fields would result in `undefined` values and a confusing downstream error.

**Fix**: Added an early guard immediately after destructuring:
```js
if (!id || !bytes) { return; }
```
Unknown message types are silently ignored before entering the pipeline.

---

## 003-err-g7h8i9 [medium] — reprocess_thumb_live swallowed errors silently

**Problem**: Failures in the thumb batch loop were caught but not reported, making it impossible to diagnose which thumb failed or why.

**Fix**: Replaced the empty `catch` block with:
```js
self.postMessage({ id: tid, type: 'error_live', error: String(err?.message || err) });
```

---

## 003-perf-g7h8i9 [medium] — fullRgb held alive during JXL encode

**Problem**: The full-resolution `fullRgb` RGB buffer was kept alive by its `const` binding while `rgb_to_rgba` ran and then throughout the long JXL encode, doubling peak memory usage.

**Fix**:
1. `rgb_to_rgba(fullRgb)` is called after both `downscale_rgb` calls (ordering was already correct).
2. After `rgba` is created, a `let fullRgbRef = fullRgb; fullRgbRef = null` pattern drops the local reference, making `fullRgb` GC-eligible during the JXL encode.
3. `imageData.data` now uses the zero-copy 3-argument `Uint8ClampedArray` constructor (`rgba.buffer, rgba.byteOffset, rgba.byteLength`) instead of copying into a new array.
