# ADR: Tile-Decode Throughput Benchmark for jxl-pyramid

**Finding:** perf-14 — No tile-decode throughput benchmark or regression gate exists for the jxl-pyramid package
**Status:** adr_draft

## Context

The `jxl-pyramid` package's pan-60fps test uses a wall-clock guard of `< 30 000 ms` — loose enough to pass on any non-frozen machine regardless of per-tile performance. Across the active optimization cycle (perf-1 through perf-13) covering WASM heap allocation, chunk-buffer reuse, and JXTC extraction, no CI gate enforces that improvements are not regressed. The cost center is `decodeTileContainerRegionRgba8` (synchronous WASM call inside each tile decode).

## Decision

Add a throughput benchmark in `packages/jxl-pyramid/test/bench-tile-throughput.ts` that:

1. Loads the existing JXTC corpus fixture (`test/fixtures/*.jxl` or the synthetic 512×512 JXTC used in decode-level tests).
2. Decodes a fixed set of representative tiles (e.g. 10 tiles × 3 sizes: 128×128, 256×256, 512×256) in a warm loop (discard first iteration to exclude WASM init).
3. Records `tiles/second` for the `rgba8` path (primary path for the viewer).
4. Asserts `tiles/second >= THRESHOLD` where `THRESHOLD` is set conservatively at ~70% of the baseline measured on the CI machine (captured once and committed as a JSON fixture).

The benchmark is run via `bun test --timeout 60000 bench-tile-throughput` as a separate npm script (`"bench"` in package.json) — not part of the default `npm test` run (avoids flakiness on slow CI agents). The regression gate CI step runs `npm run bench` only on the `jxl-pyramid` package and only on pushes to `main` or branches named `perf/*`.

## Alternatives Considered

- **Wall-clock tightening** (e.g. `< 5 000 ms`): Machine-dependent; fails on CI agents that are slower than dev machines. Rejected.
- **Microbenchmark via `performance.now()` in existing test**: Conflates WASM init cost with per-tile cost. Rejected.
- **External benchmark runner (e.g. vitest bench)**: Adds a dependency not yet in the project. Rejected in favour of the existing Bun test harness which already supports `performance.now()` timing.

## Consequences

- One new test file; no changes to source.
- The threshold JSON fixture must be re-baselined whenever the corpus or WASM bridge changes intentionally.
- Provides a meaningful regression gate for the active perf-1–perf-13 optimization work without adding CI instability.
