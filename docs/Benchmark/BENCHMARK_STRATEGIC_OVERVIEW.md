# BENCHMARK_STRATEGIC_OVERVIEW.md

**Date:** 2026-05-27  
**Branch:** feature/granular-extra-channel-modular (clean)  
**Scope:** WASM browser test pages (`web/*.html`), scripted benches (`benchmark/`), Tauri CLI examples (`src-tauri/examples/bench_*.rs` + synthesis reports). This document defines *why each surface exists* so future layout work can be purpose-driven rather than accretive.

---

## Goal

The Benchmark surfaces exist to **drive concrete engineering decisions** about the RAW→JXL pipeline and its JXL codec layer in two environments:

- Browser WASM (session/scheduler/worker/facade, progressive events, single-thread constraints, RAW wasm integration).
- Native Tauri (multi-thread libjxl + jxl-oxide, disk layout, thumb pyramids, sustained gallery/lightbox loads).

Every page/tool must map to one primary user-stated intent. Secondary intents are allowed only when they directly serve the primary without dilution.

## Intent Taxonomy (Primary Functions)

1. **Real-world feature test on image files** — Load actual user/RAW files and exercise a capability end-to-end under realistic conditions (gallery, streaming push, multiple images).
2. **Provide timings** — Deliver absolute or per-stage latency numbers (encode, decode passes, ROI tiles, pipeline stages) for a defined scenario.
3. **Compare timings between files / resolutions / settings** — Structured side-by-side or graphed comparison across variables (formats, efforts, sizes, crop rects, decoders, chunking modes).
4. **Examine progressive file painting** — Visual + per-pass metric inspection of DC / passes / detail levels; quality evolution and paint behavior as bytes arrive.
5. **Optimisation suite for best settings** — Systematic sweep of combinations (quality/effort/size/modular/brotli/resampling/threads/decoder), knee-point or scoring logic, derivation of recommended presets or architecture rules, auto-tuning for device/content.

## WASM Interactive Surfaces (web/)

| Page (hero title)                  | Primary Intent                          | Secondary | One-sentence purpose (grounded in current lede/hero) |
|------------------------------------|-----------------------------------------|-----------|-----------------------------------------------------|
| jxl-progressive.html (Progressive decode test bench) | Real-world feature test | Examine progressive, timings | Load ORF ladder (300/800/full), exercise progressive decode modes + transport pace on real files while controls stay visible. |
| jxl-progressive-paint.html (Progressive paint test) | Examine progressive file painting | Timings | Per-pass timing + visual quality viewer for progressive JXL at chosen size/quality; watch paint and metrics evolve. |
| jxl-progressive-gallery.html (Progressive gallery) | Real-world feature test | Compare (push modes) | Multi-file progressive loading in gallery-like UI with selectable chunk push modes (full-file / all-chunks / windowed) to validate streaming behavior. |
| jxl-compare.html (JXL vs JPEG vs WebP) | Compare timings | — | Format race: same ORF encoded/decoded at matched quality tiers + effort; side-by-side encode time, decode time, size. |
| jxl-crop-benchmark.html (Region decode latency by crop size) | Provide timings + Compare timings | — | Encode ORF→JXL then measure `createDecoder({region})` latency for centered crops of increasing size; informs zoom/pan ROI strategy. |
| jxl-benchmark.html (Decoder and encoder performance benchmark) | Optimisation suite | Compare timings, provide timings | Full control over iterations, files, sizes, quality, effort; "Optimize" button + permutations + charts + save-full; device-specific tuning surface. |
| jxl-wrapper-lab.html (Wrapper lab / Drag Race) | Compare timings + Optimisation suite | Real-world (batch thumbnails) | Drag-race track for JXL/WEBP/JPEG on resized tiles; exhaustive advanced encoder controls (modular, brotli, JPEG recon, resampling, filters, concurrency); batch thumbnail timing. |
| jxl-preset-benchmark.html (Preset sweep benchmark) | Optimisation suite | Compare timings | Multi-phase sweep across files/tiers; knee-point + scoring; derives and cards recommended presets (effort, decode speed, modular, resampling) with phase graphs and CSV export. |

## WASM Scripted / Automated (benchmark/)

- `raw-format-sweep.mjs`, `targeted-wasm-timings.*`, `session-worker-timings.*` → **Provide timings** + **Compare timings** (ORF/DNG/CR2, LJPEG/demosaic/tone stages, WASM vs native, worker forcing).
- `encode-option-sweep.mjs` → **Compare timings** across encoder options on real files.

These are fast, reproducible, headless; complement the interactive pages by covering pipeline internals the browser surfaces do not surface.

## Tauri Benchmark Suite (src-tauri/examples/ + reports)

All are headless CLI tools feeding the same decision record:

- `bench_comprehensive.rs`, `bench_formats.rs`, `bench_gallery*.rs` → **Compare timings** (codecs at multiple thumb sizes) + **Real-world** (gallery simulation via repeated thumb decode).
- `sweep_params.rs`, `compare_params.rs`, `bench_jpeg.rs` etc. → **Optimisation suite** (quality/effort/threads sweeps; size-vs-time tables).
- `bench_jxl_*` family + `JXL-BENCH-REPORT.md` (and siblings) → **Optimisation suite** (thumb pyramid sizing, q=85 vs 95, libjxl vs jxl-oxide crossover by resolution, ROI region decode cost, DC-only viability, disk layout (sidecar vs bundle), warm-preview 1080 + async full strategy). Includes visual inspection of output files and concrete architecture recommendations.

Tauri output is decision-grade: "store 300px @ q85 + 1080px @ q95; use libjxl ≤1920, oxide above; region-decode tiles for 1:1 zoom."

## Cross-Suite Differences (Strategic)

- **Environment constraints drive different questions.** WASM surfaces must validate worker preemption, backpressure, progressive events, chunked push, and RAW wasm pipeline under browser limits. Tauri surfaces measure native multi-thread throughput, real FS I/O, two independent JXL decoders, and long-term thumb storage economics.
- **Visual vs numeric.** WASM progressive pages are the only place you can *see* paint quality per pass. Tauri reports rely on post-facto file inspection + tables.
- **Output shape.** WASM optimization pages produce interactive charts, saved settings JSON, and preset cards for the web UI. Tauri produces architecture docs that dictate on-disk layout and decoder dispatch rules for the desktop app.
- **RAW integration.** Only WASM pages (and root cargo bench) exercise the `raw_pipeline` (ORF/DNG/CR2 → RGB8) + JXL round-trip in the same process.

## Observed Overlaps & Gaps

**Overlaps (risk of duplication):**
- Codec/format/size/effort comparison exists in jxl-compare + jxl-benchmark + jxl-wrapper-lab (WASM) and multiple Tauri benches.
- Parameter sweeping for "best settings" is in jxl-benchmark, jxl-preset-benchmark, jxl-wrapper-lab, Tauri sweep_params + JXL-BENCH-REPORT.

**Gaps (for future layout work):**
- No single surface that replays a *production gallery + lightbox open sequence* (warm preview → full decode → ROI tiles) with timings under both WASM and Tauri constraints.
- Progressive visual examination is WASM-only; Tauri progressive strategy is implicit (one-shot + frontend paint).
- RAW pipeline stage costs (demosaic especially) are only deeply instrumented in WASM scripts + native; Tauri benches start after RAW decode.
- Derived "best preset" outputs (WASM) and thumb-pyramid rules (Tauri) are not cross-linked.

## Recommended IA Principles for Refreshed Layout

1. **One primary intent per surface.** If a page is trying to be both "examine progressive painting" and "optimisation suite", split it.
2. **Declare intent in the hero.** Every benchmark page should open with a one-sentence "This page exists to…" that matches one of the five categories above.
3. **Group by intent family (not by technology).** Suggested top-level buckets for nav/docs:
   - Real-world Validation (progressive decode, progressive gallery, Tauri gallery benches)
   - Progressive Inspection (progressive-paint.html + any future DC/pass detail viewers)
   - Timing & Comparison (jxl-compare, crop-benchmark, format races, scripted sweeps)
   - Optimization Labs (jxl-benchmark + Optimize, preset-benchmark, wrapper-lab advanced, Tauri param/decoder sweeps + reports)
4. **Optimization surfaces must produce actionable artifacts.** (presets JSON, architecture rules, "use for thumbs / preview / full" badges). Pure data tables without derivation are "Compare timings", not optimisation.
5. **Automated vs Interactive distinction is visible.** Scripted benches and Tauri examples live under "Reproducible / CI" or "Headless"; browser pages are the human-facing exploration layer.
6. **Cross-suite synthesis lives in docs/Benchmark/.** The JXL-BENCH-REPORT style artifacts belong here; individual pages link to the relevant section of this overview rather than duplicating rationale.

## How to Use This Document

- Before adding a new benchmark page or major control surface, add a row to the mapping table and justify its primary intent.
- Before refactoring layout, ensure every surviving surface still has a single, crisp reason to exist from the taxonomy.
- When two surfaces compete for the same intent, prefer consolidation or clear differentiation (e.g. "interactive visual" vs "headless reproducible").

This is the single source of truth for "what Benchmark is for." Layout changes that do not improve clarity against these intents are out of scope.

---

**End of strategic overview.** (Concise by design; 98 lines.)