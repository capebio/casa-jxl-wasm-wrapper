# Working Notes: packages/jxl-scheduler/src/pool.ts
> Worker pool — spawn, lifecycle, idle reap, prewarm, spawn-failure backoff
> Feature covered: #2 (Advanced Scheduling & Flow Control)

---

## Index of Key API

| Symbol | Kind | Purpose |
|--------|------|---------|
| `WorkerPool` | class | Manages worker lifecycle: spawn, acquire, bind, release, recycle, reap |
| `acquire()` | async method | Returns an idle or freshly spawned worker (reserved), or null if at capacity |
| `bind(worker, sessionId)` | method | Transitions RESERVED → active with session ID |
| `release(worker)` | method | Returns worker to idle; arms idle timer |
| `recycle(worker)` | method | Destroys poisoned/crashed worker, removes from pool |
| `prewarm(count)` | method | Spawns N workers eagerly to eliminate first-session boot latency |
| `reapIdle()` | method | Manual idle eviction (e.g., on memory pressure); respects minIdle floor |
| `shutdown()` | async method | Awaits all in-flight spawns, then shuts all workers down |
| `healthSnapshot()` | method | Debug state dump: per-worker idle/active/cancelling/terminated |

---

## Feature #2 Coverage

| Feature | Status | Location |
|---------|--------|---------|
| Pool Pre-warming | ✅ Full | `prewarm(count)` — spawns up to `min(count, capacity)` workers eagerly; prewarm workers tracked via `spawnPromises` for safe shutdown |
| Pool Lifecycle Hardening | ✅ Full | `workers` Map (O(1) lookup) + `idle`/`active` Sets; `generation` counter for stale-spawn cleanup |
| Idle Reap | ✅ Full | `armIdleTimer()` + `reap()` — fires at `idleTimeoutMs`; `minIdle` floor preserved |
| WASM Load Retry | ✅ Full | Spawn failure → `noteSpawnFailure()` → exponential backoff via `canAttemptSpawn()` |
| Spawn Backoff | ✅ Full | `100 × 2^min(6, failures-1)` ms, capped at 5s |
| Idempotent Shutdown | ✅ Full | `shutdown()` guards with `shutdownPromise ??=`; awaits `spawnPromises` (catches prewarm races) |
| `RESERVED_SESSION_ID` Protocol | ✅ Full | `acquire()` → reserve (RESERVED) → `bind()` → active (sessionId). `bind` throws if not in RESERVED state |
| Dev Invariant Checks | ✅ Full | `assertInvariants()` in DEV: validates idle/active/workers consistency + maxSize bounds |
| `recycle()` on crash | ✅ Full | `wireWorker()` hooks `onError`/`onExit` → `recycle()` — forward-compatible via optional chaining |

---

## Bottlenecks & Issues

### 🟡 B1 — `takeIdleWorker()` is O(n) in worst case
Iterates the `idle` Set; stale/terminated workers are recycled during iteration. In practice the idle set is small (≤ maxWorkers), so worst-case iteration is bounded by `maxWorkers`. Not a real bottleneck but worth noting.

### 🟡 B2 — `drainQueue()` in scheduler: serial acquire
Pool's `acquire()` is fine — the serial bottleneck is in scheduler's `drainQueue` loop, not pool. Pool is not the constraint here.

### 🟢 B3 — Prewarm workers ARE tracked in `spawnPromises`
`prewarm` calls `void this.spawn()` — and `spawn()` adds to `spawnPromises` set. `shutdownInner` awaits `Promise.allSettled([...spawnPromises])`, so prewarm spawns are properly awaited before cleanup. No escape hatch.

### 🟢 B4 — Stale-spawn cleanup via `generation`
`spawnInner()` captures `generation` at spawn start. If `shutdown()` increments generation before the spawn completes, the newly-created worker self-shuts without entering the pool. Clean.

---

## Key Invariants

- A worker progresses through: null → RESERVED → sessionId → null (idle). Never skips states.
- `bind()` throws if worker is not in RESERVED state — enforces correct acquire→bind protocol.
- `assertInvariants()`: idle ∩ active = ∅; all idle/active workers in `workers` map; no terminated idle workers; `workers.size + spawning ≤ maxSize`.
- `cleanupAndRemove()` is the single exit point for worker removal — always clears both sets and calls `handle.shutdown()`.
- `idleCount + activeCount ≤ workers.size` (workers.size may be higher briefly during spawning before idle.add).
- `minIdle` floor: idle timer fires only if `idle.size > minIdle` at the time of firing (rechecked inside timer callback).
