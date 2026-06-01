# Fast-Path Principles

**Purpose**: Record the recurring style, decision criteria, and hunting method behind the incremental micro-optimizations on the RAW→RGB→JXL pipeline. The goal is to make the same principles easy to recognize and apply when hunting in the Tauri desktop build (and any future consumers of the shared `raw-pipeline` crate).

This document is deliberately short and principle-first. It is the companion to `docs/rejected optimizations.md`.

## Core Principles

1. **Specialize the common exact case before touching the general path.**  
   Exact integer ratios (`srcW % dstW === 0 && srcH % dstH === 0`), power-of-two factors (2/4/8), and dominant concrete types (bpc==1 / stride==4 / rgba8) appear constantly in thumbnail, lightbox cache, gallery, and encode flows. These are the highest-leverage wins.

2. **Replace f32 general arithmetic with integer stepping when the result is identical.**  
   Box-filter downscales, bilinear table construction, and ratio calculations fall into this category. The fast path must be pixel-for-pixel equivalent for the cases it covers.

3. **Eliminate per-element temporary allocations and objects on hot pixel loops.**  
   `subarray(...) + set(...)` per pixel, small `memcpy(3)` or `memcpy(4)` inside tight loops, and iterator temporaries are frequent offenders. Replace with direct indexing or a single bulk operation.

4. **Manual tight loops beat iterator chains on pixel buffers.**  
   In Rust (especially WASM glue): prefer `for` + index or `while` + `with_capacity`/`push` over `chunks_exact().map().collect()`.  
   In TypeScript: direct byte/typed-array indexing over `subarray` in the inner loop when the stride is known.

5. **Defer copies, clones, and allocations until the uncommon path actually needs them.**  
   Example: only clone the rgb16 buffer when unsharp masking (texture or clarity) is nonzero. The common "no sharpening" path borrows.

6. **Specialize only the dominant concrete type first.**  
   Land the bpc==1 or rgba8/stride==4 case immediately. Leave the 16-bit and f32 legs on the general path unless measurements show they are also hot for the workload.

7. **Layer discipline is absolute.**  
   Backpressure, queueing, deduplication, preemption, and drain logic belong only at the scheduler / worker-handler boundary.  
   Pixel math, buffer transforms, format conversion, and downscale/resize logic belong in `raw-pipeline`, `facade.ts`, `bridge.cpp`, and the thin WASM glue in `src/lib.rs`.  
   (See root `Claude.md` and repo `Claude.md` for the full layer map.)

8. **One small, verifiable change at a time.**  
   Edit → immediate narrow compile check (`cargo check --target wasm32-unknown-unknown --lib` from the WASM crate, or equivalent `cargo check` in Tauri with the right feature flags) → move to the next candidate. No opportunistic refactors in the same diff.

9. **The fast path must not change observable behavior or image quality.**  
   When the fast path triggers, output bytes (and therefore decoded pixels) must match the previous general-path result exactly.

10. **Leave a visible breadcrumb.**  
    Add a short comment containing "fast path", "integer", "exact factor", or "dominant case" so the next hunter (or future you) spots the pattern instantly.

## Hunting Heuristics (use these in Tauri too)

- Search for f32 division or multiplication inside per-row/per-pixel loops: `as f32 /`, `xr =`, `yr =`, `(dy as f32 * yr)`.
- Search for iterator transforms on image buffers inside hot functions: `.map(`, `.collect()`, `chunks_exact`, `zip`, `enumerate` on pixel data.
- Search for small fixed-size copies inside loops: `memcpy(..., 3)`, `memcpy(..., 4)`, `.set(..., subarray(`.
- Search for every call site and implementation of: `downscale`, `resize`, `bilinear`, `box_filter`, `apply_orientation`, `apply_unsharp`, `process`, `rgb_to_rgba`, `strip_alpha`, thumbnail generation.
- In the shared `raw-pipeline` crate, look at both the allocating wrappers and the `_into` variants.
- In Tauri-specific code, focus on gallery thumbnail pipelines, lightbox cache maintenance, re-render on slider changes, export/encode paths, and any place that downsamples rgb16 or rgb8 buffers coming out of the pipeline.

## Tauri Application Notes

- The `parallel` feature is enabled in Tauri builds (rayon is available). Fast paths should still short-circuit *before* rayon chunking when the integer condition holds — the spawn overhead is wasted on small thumbnail work.
- Memory allocator and heap characteristics are different (no WASM 32-bit limits). Larger scratch buffers may be acceptable, but the "no per-element temporary" rule remains a pure CPU win.
- Some hot paths shift: full-resolution editing and final export become more important than 360 px thumbs. Re-benchmark after porting a pattern.
- Because `raw-pipeline` is shared, a fast path landed in `pipeline.rs` (e.g. the `downscale_*_into` functions) automatically benefits both WASM and Tauri consumers.
- Look for Tauri-specific callers that still go through the old general paths even after the shared functions are updated (e.g. custom thumbnail sizing logic, preview generation, or clarity passes).

## Recent Examples (benchmarkfeaturechanges work)

These illustrate the principles in action:

- Exact-integer fast paths added to all four WASM-exposed downscalers plus the packed-LE variant (`src/lib.rs:160`, `243`, `784`, `882` and supporting packed path).
- Identical pattern applied to the internal shared downscalers (`raw-pipeline/src/pipeline.rs:downscale_rgb16_into` and `downscale_rgb8_into`).
- Zero-alloc direct byte writes in `bilinearResize` exact path and `applyRegionAndDownsample` (dominant stride cases) — `packages/jxl-wasm/src/facade.ts`.
- Unified `StripAlphaToRgb` helper replacing three per-pixel `memcpy` sites in encode paths (`packages/jxl-wasm/src/bridge.cpp`).
- Manual index loop + `with_capacity` upgrade for `unpack_rgb16_le` to match the style of `rgb_to_rgba` (`src/lib.rs`).
- Earlier defer-clone for unsharp masking in `apply_look` (common no-sharpen path avoids the copy).

See the git log on the `benchmarkfeaturechanges` branch for the exact diffs and verification commands used.

## Verification & Discipline

- After every edit: run the narrowest compile check that covers the changed code.
- For measured impact: use `benchmark/session-worker-timings.mjs` or `benchmark/targeted-wasm-timings.mjs` (or their Tauri equivalents) before and after when the change touches a timed path. Record p95 + median alongside mean.
- Never add tunables, thresholds, or new configuration without benchmark evidence.
- When in doubt about layer or protocol impact, re-read the "Critical Behavioral Contracts" and "Recurring False Claims" sections in the root `Claude.md`.

## Cross-References

- `docs/rejected optimizations.md` — any idea that appears here has already been evaluated and should not be re-proposed.
- Root `Claude.md` and repo `Claude.md` — layer map, invariants, and what belongs where.
- `docs/BENCHMARK_AND_TESTING_HANDOFF.md` and `TAURI_OPTION_MATRIX_BENCHMARK.md` — for measurement methodology when quantifying a new fast path.

## New Pattern Added (Wasm encode setup)

Central "mallocAndCopy" helper for the repeated "allocate WASM heap + copy Uint8Array view + track for free" pattern that appears in every encode path involving custom boxes, animation frames, box opts, etc. This eliminates duplication, guarantees the "no unnecessary copy when already Uint8Array" fast path is used everywhere, and makes future encode features cheaper to add.

This counts as a cluster win (1 helper + N call sites) on the hot encode setup path for batch/export/animation workloads.

## Hunt Completion Note (WASM Side)

After multiple aggressive waves following these principles, the major per-pixel and dominant-case heat signatures on the core WASM hot paths (all downscale entry points + fallbacks, blur kernels for texture/clarity, tone mapping, orientation, rgb conversions, alpha stripping, resize/region paths in facade, encode marshaling allocation patterns, etc.) have been extensively addressed. 

Remaining activity on pure WASM side is primarily:
- Cold metadata paths (string clones).
- Necessary one-off WASM heap buffer management in encode/decode setup (transcode, tiled, etc.).
- General f32 fallbacks for truly non-exact ratios (already guarded by fast paths and manually tightened).

The style remains the reference for any future WASM or shared pipeline work. Tauri-side callers of the shared raw-pipeline can now be hunted with the same lens.

This style keeps the work incremental, high-signal, and portable across the WASM and Tauri surfaces without requiring epic planning documents for each wave.