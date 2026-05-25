# Working Notes: packages/jxl-worker-browser/src/worker.ts
> DedicatedWorker entry point — WASM lifecycle, message routing, cold-start buffering, shutdown
> Feature covered: #2 (Advanced Scheduling & Flow Control)

---

## Index of Key State

| Symbol | Kind | Purpose |
|--------|------|---------|
| `decodeSessions` | Map | sessionId → active DecodeHandler |
| `encodeSessions` | Map | sessionId → active EncodeHandler |
| `pendingDecodeStarts` | Map | sessionId → in-flight start Promise |
| `queuedDecodeMessages` | Map | sessionId → buffered messages during cold-start |
| `shuttingDown` | flag | Gates all incoming messages once shutdown starts |
| `wasmModule` | singleton | Cached JxlModule; reset on failure for retry |
| `wasmLoadPromise` | singleton | Deduplicates concurrent load attempts |

---

## Feature #2 Coverage

| Feature | Status | Location |
|---------|--------|---------|
| Cold-Start Message Buffering | ✅ Full | Messages arriving during WASM load queued per-session (max 256); flushed when handler ready |
| WASM Load Retry | ✅ Full | `getWasm()` resets `wasmLoadPromise = null` on failure — next call retries |
| Idempotent Worker Shutdown | ✅ Full | `handleShutdown()` guards with `shutdownPromise ??=`; awaits all pending starts before cancelling |
| `release_state` Handler | ✅ Full | `handleReleaseState()` cancels decode+encode handlers, clears queued messages |
| Cross-Type Session Guard | ✅ Full | `hasAnySession()` checks decode+encode+pending maps before accepting new start |
| Uncaught Error Reporting | ✅ Full | `error` + `unhandledrejection` listeners post `worker_error` to main thread |
| Zombie-Start Prevention | ✅ Full | After WASM loads, checks `if (shuttingDown)` before creating handler — prevents late handler creation |
| Preemption Message Routing | ✅ Full | `decode_pause`/`decode_resume` routed through `routeDecodeMessage` → handler |

---

## Bottlenecks & Issues

### 🟡 B1 — Cold-start queue cap of 256 is generous
`MAX_QUEUED_MESSAGES_PER_SESSION = 256` allows buffering up to 256 chunks before WASM loads. If a session sends many small chunks rapidly, this could hold significant memory before the handler is created.
**Impact:** Low — scheduler's backpressure prevents runaway chunk delivery before a worker acknowledges readiness. The cap is a safety net for scheduler-free callers.

### 🟡 B2 — `shuttingDown` drops all messages including late cancel acks
After `shuttingDown = true`, all non-shutdown messages are silently dropped. Acks from in-flight session cancellations initiated by `doShutdown` are unnecessary (handlers resolve via `onCancel` directly), so this is correct. But any message from an external caller that arrives after shutdown starts is silently lost without error.
**Impact:** Acceptable — callers should check their AbortSignal or session lifecycle independently.

### 🟢 B3 — `getWasm()` correctly deduplicates concurrent load attempts
Two sessions starting simultaneously share the same `wasmLoadPromise`. Both await the same module — no duplicate WASM fetch. Reset on failure allows retry after transient error. ✅ Correct.

### 🟢 B4 — Startup announcement is synchronous
`self.postMessage({ type: "worker_ready", backend: "wasm" })` fires immediately on script load, before any message handler is registered. The pool's `wire` step connects the onMessage handler before any work arrives, so the ready message is always delivered. ✅

---

## Key Invariants

- Workers are stateless between sessions: `wasmModule` and `wasmLoadPromise` persist across sessions but `DecodeHandler` instances do not — they are created and discarded per session.
- `onSessionEnd` callback deletes the handler from the map — prevents stale handler accumulation.
- Cold-start queue overflow sends an error back to main thread and clears the queued messages — no silent drop.
- `doShutdown` awaits `pendingDecodeStarts` + `pendingEncodeStarts` via `Promise.allSettled` before cancelling handlers — no race between WASM load completion and shutdown.
- `handleReleaseState` calls `onCancel("release_state")` with `.catch(() => undefined)` — safe even if handler is already in terminal state.
