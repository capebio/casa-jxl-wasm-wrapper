# jxl-scheduler — DECISIONS.md

## D-001 acquire() immediately marks worker as __reserved__

Without this, two sequential acquire() calls before either bind() would return the same worker (it's idle until bound). Adding `activeSessionId = "__reserved__"` in acquire() prevents double-acquisition. Marked as a known limitation in pool comments.

## D-002 Preemption timeout set to 2 seconds

Spec does not give a timeout for waiting for decode_cancelled ack during preemption. Chose 2 s: enough for the worker to flush in-flight messages, short enough to not block the visible session for a noticeable interval. On timeout, the worker is recycled rather than reused, which is the safer option.

## D-003 Caller responsible for re-queuing after preemption

Spec says "Preempted background work re-queues with a fresh session id." The scheduler sends decode_cancel to the victim and the victim's caller sees decode_cancelled. The caller may then resubmit — the scheduler does not synthesize a new session on the caller's behalf. This is the more restrictive interpretation and avoids the scheduler needing to hold caller context for re-queuing. Note in BLOCKED.md as a design point for the integrating jxl-session layer.

## D-004 DedupeRegistry stores primary IDs only

Subscribers are stored in the registry. Fan-out message forwarding happens in Scheduler.handleWorkerMessage(). This keeps the registry's responsibility narrow: identity → primary session. It does not know about workers.

## D-005 sessionPriority map for preemption decision

Workers do not carry priority. To decide which worker to preempt, the scheduler keeps a separate `sessionPriority` map keyed by sessionId. This avoids adding priority to PoolWorker (which is purely a pool concern).

## D-006 Test runner: Node built-in (node:test)

No external test framework installed. Node 22 built-in test runner used. Tests compiled to dist-test/ and run as ESM. tsconfig.test.json handles the compilation. This avoids jest/vitest setup and keeps the package dependency footprint minimal.
