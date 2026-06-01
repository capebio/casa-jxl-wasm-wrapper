# HANDOFF: Boundary Cost Audit + WASM Optimization Campaign (June 2026)

**Context Window**: This handoff was created when context was at ~220K/512K. Start fresh from here.

**Branch**: `benchmarkfeaturechanges` (already pushed)

**Overall Mission**
We spent many sessions doing aggressive, surgical micro-optimizations on the WASM JXL + RAW pipeline using the "fast-path principles" style (integer exact-ratio fast paths, manual tight loops over iterators, elimination of per-element temporaries like subarray/set/small memcpy, dominant-case specialization, etc.).

After exhausting most high-signal opportunities in that style on the WASM side, we shifted to a new, higher-leverage lens: **Boundary Cost Audit**.

The user has now fully deferred direction, planning, and implementation to you. Your job is to drive the campaign to meaningful completion using the Boundary Cost lens.

---

## Current State (as of this handoff)

### 1. Core Artifact
- **docs/boundary-cost-audit.md** — This is the living strategic document.
  - Maps major boundaries (JS↔WASM, Main↔Worker, RAW→JXL, internal WASM malloc, etc.).
  - Contains real traces from production code and the timing harnesses.
  - Has cost tables and prioritized opportunities (Tier 1/2/3).
  - Recently updated with an Execution Plan (Phase 2A focused on RAW→JXL boundary).

### 2. Recent Implementation (Phase 2A start)
- Added `take_rgba()` and `rgba()` methods to `ProcessResult` in `src/lib.rs`.
  - These perform the RGB→RGBA conversion inside WASM.
  - Goal: Eliminate the common `result.take_rgb()` + `rgb_to_rgba(...)` pattern in JS that was causing multiple full image-sized copies before JXL encoding.
- Rolled out (with safe fallback) to the key measurement tools:
  - `benchmark/session-worker-timings-browser.js`
  - `benchmark/targeted-wasm-timings.mjs`
  - `benchmark/encode-option-sweep.mjs`
- Verified: `cargo check --target wasm32-unknown-unknown --lib` passes cleanly.

This is the first concrete implementation step coming out of the Boundary Cost Audit.

**Note for the next session**: The user has asked to "commit and push and ensure everything is written up in that .md document" before continuing deeper implementation. The handoff + audit docs should be the primary artifacts.

### 3. Previous Work (for context)
- Dozens of micro-wins across `src/lib.rs`, `packages/jxl-wasm/src/facade.ts`, and `bridge.cpp` (downscale integer paths, blur kernel manualization, orientation tightening, alpha strip helper, mallocAndCopy helper for encode marshaling, etc.).
- Created `docs/fast-path-principles.md` as the reference for the original hunting style.
- All work has been surgical, immediately verified, and documented.

### 4. Key Insight Driving Current Direction
For typical "RAW decode → JXL encode" workflows (especially those measured in the Gobabeb / session-worker timing harnesses), there are **3–4 full image-sized buffer allocations/copies** before data even reaches libjxl's encoder. This is now the dominant remaining cost center after the per-pixel work.

---

## Guiding Principles (Do Not Drift)

- **Surgical over heroic**: Small, verifiable changes. No big refactors unless the audit clearly justifies it.
- **Update the audit doc** as you discover new traces or refine opportunities.
- **Stay primarily on WASM side** for now (per user's last explicit direction), unless the boundary analysis naturally leads into shared raw-pipeline code.
- **Measure when possible**: The timing harnesses (`session-worker-timings*`, `targeted-wasm-timings`) are your friends.
- **Follow the Boundary Cost lens**: Focus on data movement, ownership handoffs, malloc+set patterns, transfer lists, and unnecessary copies across JS/WASM and thread boundaries.

---

## Recommended Way Forward (My Proposed Plan)

**Immediate Goal**: Complete and measure Phase 2A (RAW → JXL boundary reduction), then decide on next highest-leverage boundary.

### Short-term (next 1-2 sessions)
1. **Deepen the RAW → JXL implementation**
   - Consider producing RGBA8 directly inside the tone/convert stage in some paths (instead of post-hoc conversion in `take_rgba`).
   - Update more call sites (web/ code, other benchmarks, jxl-wrapper-lab.js if relevant).
   - Add a small metric or console trace in the timing harnesses to quantify the "rgbaPrepMs" savings.

2. **Strengthen the Audit Document**
   - Add more precise before/after cost estimates once measurements exist.
   - Flesh out the other high-value boundaries (decode pixel handoff, animation marshaling, worker transfers).

3. **Decide on next target**
   - After Phase 2A measurement, pick the next Tier 1 opportunity from the audit (e.g., keeping decoded pixels in WASM longer, better ownership model for progressive output, or batching improvements).

### Medium-term
- Move from "sketch" to "measured impact" on the biggest boundaries.
- Possibly apply the same Boundary Cost lens to Tauri/desktop paths if WASM wins plateau.
- Consider whether any findings justify small bridge extensions (new FFI functions for lower-copy handoff).

---

## Key Files & Locations

**Strategic Docs**
- `docs/boundary-cost-audit.md` ← Primary working document
- `docs/fast-path-principles.md` ← Reference for the older micro-optimization style
- `docs/HANDOFF-boundary-cost-audit-2026.md` ← This handoff

**Core Implementation**
- `src/lib.rs` — RAW pipeline outputs (`ProcessResult`, `take_rgba`, `rgb_to_rgba`, process_* functions)
- `packages/jxl-wasm/src/facade.ts` — JS side of JS↔WASM boundary (marshal functions, copyOrBorrowInput, takeBuffer, etc.)
- `packages/jxl-wasm/src/bridge.cpp` — WASM memory management and direct libjxl buffer usage

**Measurement / Real Usage**
- `benchmark/session-worker-timings-browser.js` (most important)
- `benchmark/targeted-wasm-timings.mjs`
- `benchmark/encode-option-sweep.mjs`
- `web/jxl-wrapper-lab.js` and `web/main.js` (real usage patterns)

---

## Open Questions / Risks to Watch

- How much actual savings will `take_rgba()` deliver in practice vs. just moving the conversion cost?
- Is there appetite (and low risk) for a more invasive change, such as optional direct RGBA production during the final `process` step?
- Some boundaries (e.g., one-off transcode/tiled buffers) may never be worth optimizing heavily because they are not on the hot path.
- Avoid over-engineering ownership models unless measurements show it's worth it.

---

## How to Continue from Here

1. Read `docs/boundary-cost-audit.md` (especially sections 7–9).
2. Read this handoff.
3. Run `cargo check --target wasm32-unknown-unknown --lib` + any relevant benchmark checks to get your bearings.
4. Decide whether to:
   - Finish/measure the current `take_rgba` rollout, **or**
   - Deep-dive another boundary from the audit, **or**
   - Propose a more ambitious design for the RAW→JXL handoff.

You have full authority to set direction. The user explicitly said they are done and are deferring planning + implementation to you.

Good hunting.

— Previous Grok instance (June 2026)