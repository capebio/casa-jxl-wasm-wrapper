# ADR: Scheduler Throughput Benchmark

**Task:** 009-performance-13
**Status:** proposed

## Context

There are no benchmarks measuring `tick()` time under a full 50-job queue, `onChunk` throughput under simulated streaming, or `armEarliestRetryTimer` cost. Without a perf baseline, the per-RAF allocation patterns can silently regress.

## Decision

Add a `bench/scheduler.bench.ts` (or Vitest bench file) that:
1. Creates a `ProgressiveGallery` with `maxQueuedJobs=50` and 50 synthetic jobs.
2. Calls `tick()` in a tight loop (10 000 iterations) and measures wall time.
3. Simulates streaming 1 000 `onChunk` calls of 4 KB each and measures total time.
4. Reports p50/p95 per-tick latency.

## Consequences

- Benchmark must run in Node.js (no browser globals required beyond stubs).
- CI gate: if p95 tick time regresses by >2× versus baseline, fail the benchmark job.
- Deferred until the tick() hot-loop fixes (performance-1/2/3) are merged, so the baseline captures the improved state.
- Benchmark file should live at `packages/jxl-progressive/bench/scheduler.bench.ts`.
