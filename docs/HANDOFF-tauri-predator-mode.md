# HANDOFF: Tauri Predator Mode — Seek & Destroy Inefficiencies

**Date**: June 2026  
**Branch**: `benchmarkfeaturechanges`  
**Context**: Continuation of the long-running optimization campaign. We exhausted most high-signal "fast-path" micro-optimizations on the WASM side and shifted to a Boundary Cost Audit lens. The user now wants to apply the same aggressive, surgical "predator mode" hunting style to the Tauri desktop application.

---

## Core Strategy Documents (Read These First)

1. **`docs/fast-path-principles.md`** — This is the primary reference for the hunting style.
   - Core principles: specialise the common exact case, replace f32 general math with integer stepping when safe, eliminate per-element temporaries/allocations, prefer manual tight loops over iterators on pixel data, defer clones until actually needed, specialise only the dominant concrete type first, strict layer discipline, one small verifiable change at a time, leave breadcrumbs.
   - Hunting heuristics are listed explicitly.

2. **`docs/boundary-cost-audit.md`** — The higher-level strategic lens we developed later.
   - Focuses on data movement costs across boundaries (memory copies, ownership handoffs, JS/WASM or thread crossings, malloc patterns, etc.).
   - Contains concrete traces and prioritised opportunities.
   - This lens is especially powerful for desktop apps like Tauri where you have more control over threading, memory, and IPC.

3. **`docs/HANDOFF-boundary-cost-audit-2026.md`** — Previous handoff that captures the evolution from pure fast-path hunting to the boundary cost view. Useful for understanding the full arc of the campaign.

---

## How to Operate in "Predator Mode" on Tauri

### Mindset
- Aggressive but surgical. Think like a rugby prop or predator: seek heat signatures (hot loops, repeated allocations, unnecessary copies, f32 math on pixel data, iterator chains over buffers, small per-element copies, etc.).
- Page-at-a-time / as-you-come-across-them. No epic upfront planning unless the boundary audit naturally leads there.
- Every change must be small, verifiable, and low-risk.
- Update the strategy documents as you discover new patterns.

### Two Complementary Lenses

**Lens A — Fast-Path Principles** (tactical, high-volume micro-wins)
- Look for exact integer ratios in any downscaling/resizing/thumbnail code.
- Manual loops instead of `.map()`, `.iter().enumerate()`, `zip`, etc. on image buffers.
- Eliminate per-pixel `subarray`/`set`, small `memcpy`, or `copy_from_slice(3)` / `copy_from_slice(4)`.
- Specialise for the dominant case (e.g., 8-bit RGBA, common thumbnail sizes like 360px/1800px, power-of-2 factors).
- Defer expensive work (clones, unsharp, tone mapping) until it is actually required.

**Lens B — Boundary Cost Audit** (strategic/systems view)
- Trace full data flows: RAW decode → thumbnail/lightbox caches → gallery rendering → export.
- Count every full image buffer copy or ownership handoff.
- Look at Tauri command boundaries, frontend ↔ backend IPC, filesystem reads/writes, GPU uploads, etc.
- High-leverage areas are usually where large buffers cross layers repeatedly.

---

## High-Potential Hunting Grounds in the Tauri App

Based on the structure (`src-tauri/src/`, shared `raw-pipeline` crate, various benches):

### 1. Image Pipeline Hot Paths (raw-pipeline + Tauri glue)
- Thumbnail and lightbox generation paths (very similar to WASM cache creation).
- Any downscaling/resizing code (the shared `downscale_*` functions in `raw-pipeline/src/pipeline.rs` already received some integer fast paths — look for callers that may still go through slow paths).
- Unsharp masking / clarity / texture application (the separable blur kernels were heavily optimised on WASM — check Tauri usage).
- Tone mapping and final colour conversion steps.

### 2. Priority & Concurrency Layer
- `priority_sem.rs` — likely a priority semaphore for background processing. Look for allocation or queuing inefficiencies.
- `push.rs` — pushing images through the pipeline.
- Any job queuing or worker pool logic.

### 3. Gallery / Lightbox / UI Rendering Paths
- How thumbnails are loaded, cached, and displayed.
- Lightbox rendering when sliders change (this was a big win area on WASM via `LookRenderer`).
- Batch processing or export flows.

### 4. Filesystem & Caching Boundaries
- Thumbnail cache on disk.
- Any OPFS-like or local cache logic (Tauri has different primitives).
- Repeated reads of the same RAW file during development or batch operations.

### 5. IPC / Tauri Command Boundaries
- Commands that transfer large pixel buffers between Rust and the frontend (Svelte/TS).
- Any place that serialises/deserialises image data.

### 6. Benchmark & Test Code (as reconnaissance)
- The various `bin/*_bench.rs` files are excellent for finding hot paths quickly (`lightbox_bench.rs`, `dng_bench.rs`, etc.).
- `bench.rs`, `casabio.rs`, etc.

---

## Differences from WASM Work (Important Context)

- **Threading**: Tauri desktop can use real threads / rayon (the shared `raw-pipeline` already has a `parallel` feature). Some WASM wins that avoided rayon overhead may need revisiting or different treatment.
- **Memory Model**: No WASM linear memory limits. Larger scratch buffers or arenas may be acceptable, but unnecessary copies still hurt.
- **Ownership & Zero-Copy**: Easier to keep data in Rust longer. Look for places where data is unnecessarily cloned to cross into the frontend.
- **Performance Characteristics**: Desktop CPUs are generally faster and have bigger caches, but users expect snappier response on large files. Focus on perceived performance (first thumbnail, lightbox pop, slider responsiveness).
- **File I/O**: Real filesystem access — caching strategy and I/O patterns become more important.

---

## Recommended Operating Rhythm

1. Start with reconnaissance using the hunting heuristics from `fast-path-principles.md`.
2. Use the benches (`lightbox_bench`, `raw-format-sweep`, etc.) as rapid feedback loops.
3. Apply both lenses (fast-path + boundary cost).
4. Make one small change → verify (cargo check + relevant bench) → document in the audit or principles doc if it reveals a new pattern.
5. Keep updating `docs/boundary-cost-audit.md` with Tauri-specific traces and opportunities.

---

## Suggested First Steps

1. Read the three strategy documents listed at the top.
2. Run one of the lightbox or RAW format benches to get a feel for current hot paths.
3. Focus initially on thumbnail/lightbox generation paths in the Tauri app (highest overlap with previous WASM wins).
4. Look specifically for any remaining general f32 downscale paths or iterator-heavy pixel loops that the shared crate improvements didn't fully reach.
5. Trace a full "import RAW → show in gallery → open in lightbox → tweak sliders → export" flow and count buffer copies.

---

## Success Criteria

- Measurable improvements in thumbnail generation, lightbox responsiveness, or export times on the Tauri side.
- New patterns or Tauri-specific adaptations added back into the strategy documents.
- Clear documentation of remaining high-cost boundaries in the Tauri app.

---

You now have full context from the entire WASM campaign plus the strategic shift to boundary costing. Apply the same predator intensity, but adapted to the desktop environment.

Good hunting. Update the docs as you go so the next person (or future you) can continue the campaign cleanly.

---

## Focused Predator Campaign: Progressive Encode/Decode (June 2026)

See the dedicated handoff `docs/HANDOFF-predator-progressive-2026.md` (created in same session).

**Summary of that hunt**:
- User-reported: paint page with "6 passes" only ever emitted 2 nearly-identical events (~60ms each); push-to-gallery didn't work so couldn't demo in the gallery benchmark.
- Root: `resolveEncoderBridgeSettings` hard-coded `progressiveDc:1` (and no `groupOrder`); paint/gallery "benchmark" surfaces never passed higher values; "push" was just download+open+manual hint.
- Surgical fixes: extended `EncoderOptions` (facade + core + protocol), made resolve respect `progressiveDc` (0/1/2) from caller (Dc path was already in FFI/C++), wired paint to request Dc=2+group=1 for >=6, implemented real localStorage push + auto-consume in gallery so "export" now auto-feeds the exact test file for multi-layer viewing.
- Also forwarded through session/handlers for high-level parity.
- No WASM rebuild needed for the Dc win (groupOrder will need FFI + C++ + rebuild).
- Result: the two benchmarks can now be used to produce + observe multiple progressive layers. Early passes will be distinct (more with groupOrder).
- Remaining heat map + plan in the dedicated handoff (plumb groupOrder, smart defaults, per-pass quality metrics, "bytes to recognizable", Tauri side, deeper facade/bridge emission opts, integration with jxl-progressive policies, etc.).

Use the same rhythm: small verifiable change, measure on the pages + existing runs, update docs. This is prime predator territory because the encode structure directly gates all the fancy decode progressive machinery we built.

Add findings back here if they reveal new general fast-path or boundary patterns.