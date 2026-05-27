# jxl-worker-browser — DECISIONS.md

## D-001 file: reference instead of workspace:*

Package manager at root is npm/bun without workspace config. Used `"file:../jxl-core"` for the jxl-core dependency. T-INT should migrate to workspace protocol when the monorepo root is configured.

## D-002 WASM loaded lazily, not at worker startup

Spec says "WASM module compiled once at worker startup." Chose lazy load on first session instead: avoids blocking the worker_ready announcement for callers that probe capabilities before starting sessions, and matches the IndexedDB cache path where async is unavoidable. If the first session's startup latency is unacceptable, move loadWasmModule() call to before postMessage(worker_ready).

## D-003 WorkerHandle.onMessage replaces not appends

`onMessage` replaces all handlers, not appends. The scheduler (jxl-scheduler) is expected to register one handler per pool worker. Multiple handlers would require the caller to multiplex; keeping it simple here.

## D-004 Handler crash isolation via Promise rejection catch

Each handler's `run()` is `await`ed inside a `.catch()`. A handler crash emits `decode_error`/`encode_error` and calls `onSessionEnd`, removing itself from the map. The worker continues serving other sessions. Per spec Section 18.2: "Worker crash invalidates the session, recycles the worker, fails the session with WorkerCrashed. Other sessions on the pool are unaffected." — a handler crash does NOT crash the worker; only a memory-level failure (which would cause an unhandled exception from outside the handler Promise) would. The `worker.onerror` in spawn.ts catches that case and reports `WorkerCrashed` to the scheduler.
