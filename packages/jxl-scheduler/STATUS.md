# jxl-scheduler — STATUS.md

## Status

Complete. Scheduler primitives and integration tests are in place.

## Delivered

- Worker pool with idle reaping, recycling, and reservation
- Priority queue with visible / near / background lanes
- Dedupe registry with fan-out and partial-cancel handling
- Scheduler with preemption, dedupe, budget, and backpressure
- Unit and integration test coverage
- Typecheck passes clean

## Deferred

- T-INT depends on other branches landing.
- Worker backpressure emission still depends on downstream decode/encode loops posting `worker_drain`.
- Preempted background work still re-queues in the caller layer, not in the scheduler.

## Notes

- See `STATE.md` for task history.
- See `BLOCKED.md` for the known integration limits.
