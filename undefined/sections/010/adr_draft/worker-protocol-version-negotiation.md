# ADR: Worker Protocol Version Negotiation Strategy

**Task:** 010-contracts-012
**Finding:** WorkerRequest/WorkerReply versioned with literal `v:1` but no version negotiation
**Status:** deferred_adr

---

## Context

All messages in the jxl-pyramid worker protocol (`worker-protocol.ts`) carry `v: 1`. The inbound `parseWorkerReply` rejects messages where `d.v !== 1` by returning `null`, which the caller treats as `INVALID_REPLY`. There is no handshake, no capability advertisement, and no graceful degradation for version skew.

The version field was added with forward-compatibility intent, but without a mechanism to detect or handle a skew between the pool (main thread) and a worker script loaded from a different bundle version. This is acceptable for a same-bundle deployment but becomes a silent timeout failure if:
- A stale service-worker or CDN-cached `tiled-decode-worker.js` is served alongside a newer `jxl-pyramid` bundle.
- A native worker (jxl-worker-node) is at a different release than the pool.

## Decision Options

### Option A: No negotiation — fail fast via `validateWorkerRequest` (current direction)
The newly added `validateWorkerRequest` (contracts-011) catches outbound malformation in dev. The `parseWorkerReply` already rejects `v !== 1`. Incoming version mismatches produce `INVALID_REPLY` which the pool surfaces as a decode error. No changes needed.

**Pros:** Zero overhead, no protocol complexity.
**Cons:** Version skew produces confusing decode failures with no diagnostic. Upgrading the protocol in a future version requires a flag day.

### Option B: Capability handshake on `ready`
Extend the `ready` reply to carry the worker's protocol version and supported features:
```
{ v: 1, type: 'ready', workerV: number, caps?: string[] }
```
The pool reads `workerV` from `parseWorkerReply` and records it on the handle. If `workerV < expectedV`, the pool logs a warning and either continues (best-effort) or marks the handle `Bad`.

**Pros:** Version skew is detectable and diagnosable.
**Cons:** Requires matching change in `tiled-decode-worker.js` (JS file, not TS-compiled), adds a field to the `ready` shape, and requires `parseWorkerReply` to surface the field.

### Option C: Version in every message (current) + out-of-band negotiation header
Keep `v: 1` on every message. Add an HTTP/cache header to the worker script that encodes its protocol version. The pool reads this at worker spawn time (not feasible for Workers constructed from a URL without a separate fetch).

**Assessment:** Not viable in a web Worker context without custom loader infrastructure.

### Option D: Bump to v:2 when needed, dual-mode pool
When a protocol change is needed, emit `v: 2` messages and provide a compatibility shim that detects old workers (which reply with `v: 1` to a `v: 2` request) and falls back.

**Pros:** Backward compat during rolling deploys.
**Cons:** Pool complexity doubles for every version transition; complexity is proportional to how many versions need to be supported simultaneously.

## Recommendation

**Adopt Option B** with a minimal implementation scope:

1. Worker sends `{ v: 1, type: 'ready', workerV: 1 }` (adding `workerV` field).
2. `parseWorkerReply` extracts `workerV` from the ready message.
3. The handle stores `workerV`. The pool logs a `DEV` warning if `workerV !== EXPECTED_WORKER_V` (a new module-level constant).
4. No auto-degradation: mismatched workers are still used but the warning surfaces in devtools.

This is a two-file change (`tiled-decode-worker.js` + `worker-protocol.ts` + `tiled-decode-pool.ts`) and requires coordinated deploy of the worker script. The change is backward-safe: old workers that don't send `workerV` produce `undefined`, which the pool treats as v:1 (unchanged behavior).

## Deferred Until

- A concrete scenario where version skew has caused a support issue, OR
- The first planned protocol change (e.g. adding a new message type) that needs a flag day.

The `validateWorkerRequest` added in contracts-011 covers the immediate dev-mode safety gap without requiring any negotiation infrastructure.
