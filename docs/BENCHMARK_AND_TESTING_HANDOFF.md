# Benchmark & Testing Handoff

**Date:** 2026 (endgame on feature/granular-extra-channel-modular)  
**Status:** Feature implementation complete. Only benchmark, testing, and release hygiene remain.

This document unifies the 2026-05-27 benchmark intent analysis with the production-readiness assessment from the same period (as historical snapshot) and a focused remaining-work list for the final phase.

---

## Historical Snapshot (2026-05-27 Production Assessment)

At the codec and runtime layer the wrapper was already close to production viability before the final feature waves (RAW parity, granular extra-channel-modular, animation decode, JUMBF, first-class advanced controls).

**What looked solid (May 2026):**
- Real WASM artifacts (scalar/SIMD/SIMD-MT) with provenance.
- `packages/jxl-wasm/src/facade.ts` and `bridge.cpp` supporting progressive decode/encode, metadata round-trips (ICC/EXIF/XMP), viewport helpers, sidecars, JPEG transcode, region fallback.
- Worker/session/scheduler layers with preemption, dedupe, budget, pause/resume, cold-start buffering, and cancellation.
- `src/lib.rs` RAW pipeline (ORF/DNG) with LookRenderer, DNG color matrix/ISO fidelity, and orientation fast-paths.
- Rust checks and the overall package shape.

**Honest v1 scope (no native/PGO/true-ROI guarantees):**
- WASM-first browser and Node (with WASM fallback in Node).
- Metadata-preserving encode/decode.
- Progressive preview.
- Viewport helpers with documented full-frame-then-crop fallback.

Production blockers at the time (package/release hygiene, verification harness trust, ROI story, native Node proof, threaded WASM deployment contract, PGO operationalization) have seen substantial progress through later work recorded in the Parity matrix and Progress Log. The assessment below therefore focuses on the benchmark surfaces that must now drive the final engineering decisions.

Source material: `Strategic_overview.md`, `Strategic_overview_checklist.md` (May 27).

---

## Benchmark Surfaces — Intent Taxonomy & Known Gaps (2026-05-27)

The benchmark surfaces (web/*.html, `benchmark/` scripts, Tauri `src-tauri/examples/bench_*.rs`) exist to drive concrete engineering decisions in two environments: browser WASM (session/scheduler/worker constraints, progressive events, RAW integration) and native Tauri (multi-thread libjxl, FS I/O, sustained gallery/lightbox loads).

### Primary Intent Categories
1. Real-world feature test on image files
2. Provide timings (absolute or per-stage latency)
3. Compare timings between files / resolutions / settings
4. Examine progressive file painting (DC/passes/detail evolution)
5. Optimisation suite for best settings (sweeps, knee-points, preset derivation, auto-tuning)

### WASM Interactive Surfaces (web/)
- `jxl-progressive.html` — Real-world + progressive (ORF ladder, transport pace).
- `jxl-progressive-paint.html` — Progressive painting inspection + per-pass metrics.
- `jxl-progressive-gallery.html` — Multi-file streaming gallery (chunk push modes).
- `jxl-compare.html` — Format race (JXL vs JPEG/WebP at matched quality).
- `jxl-crop-benchmark.html` — Region decode latency by crop size.
- `jxl-benchmark.html` — Full optimisation suite (iterations, charts, permutations).
- `jxl-wrapper-lab.html` — Drag-race + advanced encoder controls (modular, brotli, JPEG recon, resampling, filters) + batch thumbnails.
- `jxl-preset-benchmark.html` — Preset sweep (knee-point scoring, recommended cards, CSV).

### Scripted / Tauri
- `benchmark/*.mjs` (raw-format-sweep, targeted timings, encode-option-sweep, session-worker-timings) — reproducible headless timings + comparisons, including RAW pipeline stages.
- Tauri `bench_*.rs` family + `JXL-BENCH-REPORT.md` outputs — decision-grade architecture rules (thumb pyramids, decoder choice by resolution, sidecar vs bundle, warm-preview strategy).

### Cross-Suite Strategic Differences
WASM surfaces are the only place progressive paint can be *seen* and the only surfaces exercising the full RAW → JXL round-trip in one process. Tauri surfaces measure native multi-thread throughput, real FS I/O, and long-term storage economics. Output shapes differ: WASM produces interactive charts + preset JSON; Tauri produces architecture docs.

### Observed Overlaps & Gaps (Still Relevant)
**Overlaps (risk of duplication):** codec/format/size/effort comparisons and parameter sweeps exist in multiple WASM pages and multiple Tauri benches.

**Gaps (actionable for the final phase):**
- No single surface that replays a production gallery + lightbox open sequence (warm preview → full decode → ROI tiles) under both WASM and Tauri constraints.
- Progressive visual examination is WASM-only.
- RAW pipeline stage costs (especially demosaic) are deeply instrumented only in WASM scripts + native; Tauri benches start after RAW decode.
- Derived "best preset" outputs (WASM) and thumb-pyramid rules (Tauri) are not cross-linked.

### Recommended IA Principles for Refreshed Layout
1. One primary intent per surface.
2. Declare intent in the hero ("This page exists to…").
3. Group by intent family, not technology (Real-world Validation, Progressive Inspection, Timing & Comparison, Optimization Labs, Reproducible/CI).
4. Optimization surfaces must produce actionable artifacts (presets JSON, architecture rules, badges).
5. Automated vs interactive distinction must be visible.
6. Cross-suite synthesis belongs in docs (this handoff or a dedicated Benchmark/ note); individual pages link here rather than duplicating rationale.

Source: `Benchmark/BENCHMARK_STRATEGIC_OVERVIEW.md` (2026-05-27, same branch).

---

## Remaining Work — Benchmark & Testing Phase

Prioritized list derived from the gaps above, open cells in `FEATURE_PARITY_MATRIX.md`, test gaps documented in root `Claude.md`, and the IA recommendations.

**High (directly unblocks release honesty):**
- Implement or prototype the missing "production gallery + lightbox open sequence" replay surface (or scripted equivalent) that exercises warm preview → full decode → ROI tiles under both WASM and Tauri constraints. Record timings and memory in the style of existing Tauri JXL-BENCH-REPORT outputs.
- Close or explicitly document the RAW pipeline stage instrumentation gap for the Tauri/desktop path (demosaic especially).
- Cross-link WASM preset cards with Tauri thumb-pyramid rules so a single "recommended settings" artifact exists for both environments.
- Exercise every 🟡 and ❌ cell in the Parity matrix inside the existing benchmark UIs (wrapper-lab, preset-benchmark, animation-lab, crop-benchmark) and record results in the matrix + Progress Log.

**Medium (verification & harness trust):**
- Run the decode-handler test gaps listed in root `Claude.md` (cancel-while-paused, budget-exceeded-before-first-progress, many-small-chunks drain coalescing, `budgetMs == null` safety, DRAIN_MIN_INTERVAL_MS spam prevention) against current scheduler/worker code on the feature branch.
- Make the verification harness (npm/bun test + pack-test) trustworthy end-to-end on CI for the current state (address any remaining source-vs-dist or runner drift).
- Add or update hero/intent declarations on the web/ benchmark pages per the IA principles; group navigation or docs accordingly.

**Low / Polish:**
- Update `FEATURE_PARITY_MATRIX.md` "Benchmark Exposure" column with any new surfaces or explicit "N/A" notes from the gallery+lightbox replay work.
- Add a one-paragraph "Project Wind-Down" entry to `references/PROGRESS_LOG.md` recording this docs cleanup and the transition to pure benchmark/testing.
- Optional: produce a short `docs/Benchmark/BENCHMARK_IA_STATUS.md` (or section here) tracking which of the 6 IA principles have been actioned.

All work must update `FEATURE_PARITY_MATRIX.md` and `references/PROGRESS_LOG.md` on landing, per existing convention.

---

## Pointers to Living Reference Documents

- `FEATURE_PARITY_MATRIX.md` — single source of truth for feature completeness, WASM vs Tauri parity, and benchmark exposure.
- `references/PROGRESS_LOG.md` — detailed chronological implementation journal with verification commands and branch notes.
- `rejected optimizations.md` — canonical record of rejected ideas (read before touching scheduler, pool, facade, or decode-handler).
- `file-summary/` — per-library code reference material (lib.rs, scheduler.ts, pool.ts, worker.ts, decode-handler.ts, facade.ts, bridge.cpp, etc.).
- `references/designs/` — feature design notes (including the current branch's `granular-extra-channel-modular.md`) + `DESIGNS_INDEX.md` and `ISSUES.md`.
- `references/README.md` + `REFERENCE_INDEX.md` / `REFERENCE_CODE_AUDIT.md` — reference implementation extracts from libjxl / jpegxl-rs / chafey.

---

**End of handoff.** The benchmark surfaces now own the final engineering decisions. Use the intent taxonomy and IA principles above to keep the surfaces purposeful rather than accretive.