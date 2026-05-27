# jxl-scheduler — BLOCKED.md

## B-001 Re-queue after preemption is caller responsibility

Spec says preempted background work re-queues with a fresh session id. Current implementation sends decode_cancel to the victim and lets the victim's caller (jxl-session) handle the decode_cancelled event and resubmit. The scheduler does not auto-requeue. jxl-session must implement resubmit logic.

## B-002 backpressure signal from worker (worker_drain)

The scheduler's waitForDrain() and signalDrain() are wired, but the worker must post `worker_drain` messages after processing each input chunk. jxl-worker-browser and jxl-worker-node handlers (stub) do not yet emit this. Once T-DECODE-WASM fills in the decode loop, it must post `{ type: "worker_drain", sessionId }` after consuming each chunk and the queue depth drops below HWM.

## B-003 findQueuedSession returns null (stub)

Scheduler.findQueuedSession() always returns null because PriorityQueue does not expose a find-by-id method that walks all lanes. Currently this only affects the preemption code path where we check if a victim is in the queue. For the integration pass, add a Map<sessionId, PendingSession> in the scheduler for O(1) lookup.
