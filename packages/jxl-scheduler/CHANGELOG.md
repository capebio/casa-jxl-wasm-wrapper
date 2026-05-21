# @casabio/jxl-scheduler — Changelog

## v0.1.0 (2026-05-21)

- Initial release.
- WorkerPool: creation, idle reaping, recycling on poison, reservation.
- PriorityQueue: three lanes (visible > near > background).
- DedupeRegistry: source-identity fan-out, partial-cancel semantics.
- Scheduler: pool + queue + dedupe + preemption + budget + backpressure.
- 18/18 integration-grade tests pass (node:test, Node built-in runner).
- tsc clean (strict, ES2022, bundler).
