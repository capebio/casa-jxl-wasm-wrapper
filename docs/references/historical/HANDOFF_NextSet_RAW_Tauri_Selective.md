# Handoff — Next Set: RAW Tauri Selective Processing & Decode/Process Split (excl. B5/C2/C3)

**Branch:** `finishing_feature_parity` (stay on this single branch)  
**Date of handoff:** 2026-06  
**Context level at handoff:** ~50% (fresh handoff recommended before further deep work)  
**Status:** Incremental progress made on the remaining RAW Tauri parity items after B1–B4. B5 (in-flight preemption), C2 (JXTC native), and C3 (progressive/streaming encode on native) are explicitly excluded per prior directive and have separate handoffs.

## What Has Been Completed in This Phase (Next-Set Work)

- Added `ProcessingMode` ("full" | "thumb" | "lightbox") to `ProcessOptions` (Tauri).
- Implemented `get_orf_thumb(path)` — fast gallery path using B4 public helpers (`parse_orf_metadata`, minimal decode + early downscale). Returns thumb + metadata without full tone/JXL.
- Major selective optimization: In "thumb" mode, the main `process_file` now tones **only the lb16 buffer** and uses the result as the JXL source (avoids full-res tone curve entirely for gallery workloads).
- Extracted `tone_and_orient_for_mode(...)` helper — makes the main spawn_blocking block in `process_file` less monolithic and demonstrates the decode vs. selective-process split.
- Strengthened thumb-from-lb derivation (items 5 + 2): thumb and lightbox outputs now consistently prefer the pre-downscaled lb16 when available.
- Fixed latent reference issues (e.g., `effective_orientation`) during refactoring.
- Updated `FEATURE_PARITY_MATRIX.md` (items 2, 5, 10 advanced to 🟡 with specific notes on the new mode/helper/lb16-for-JXL behavior).
- Added incremental entries to `PROGRESS_LOG.md`.
- Commits + pushes performed on `finishing_feature_parity` + sibling `raw-converter-tauri` after meaningful slices.

See the "Next-set after B4 (excl. B5/C2/C3)" section in `PROGRESS_LOG.md` for the detailed session log.

## Current State of Remaining Items in This Bucket (from FEATURE_PARITY_MATRIX.md §1)

Focus only on these (RAW Tauri side). All other high-impact gaps (B5, C2, C3, Advanced Controls/M3) are out of scope.

- **Item 2** (`process_orf_with_flags` + selective bitmask): 🟡  
  WASM has full `OUT_*` flags + `process_orf_impl`/`decode_orf_raw` split.  
  Tauri now has `ProcessingMode` + helper + thumb-mode lb16-for-JXL optimization + `get_orf_thumb` fast path.  
  **Not complete:** Full bitmask integration in the main `process_file` path, proper "lightbox" vs "full" differentiation, callers that can request only thumb/metadata without JXL.

- **Item 5** (Thumb derived from pre-computed lightbox buffer): 🟡 (stronger after next-set)  
  B2 added shared downscales + initial lb16 preference. Next-set made JXL source itself come from toned lb16 in thumb mode.

- **Item 9** (Pre-allocated fixed buffers for downscales): 🟡 (untouched in next-set)  
  Tauri still uses `par_chunks` with fresh `Vec` allocations inside the downscale helpers (copied from earlier patterns). WASM side has more deliberate fixed-buffer thinking in some paths.

- **Item 10** (decode_orf_raw / process_orf_impl split): 🟡 (good progress)  
  WASM has clean separation. Tauri `process_file` was monolithic. We now have `tone_and_orient_for_mode` helper + mode-aware branching after demosaic/NR. The decode (up to lb16) is still entangled with the selective process step.

**Matrix summary section** is partially stale — it still lists the high-level "B1/B2/B4 landed" language. Update it when you land the next real slice.

## Recommended Next Steps (Prioritized for Incremental Value + Clean Code)

Follow the spirit of `FEATURE_IMPLEMENTATION_TEMPLATE.md` even on this single branch: small slices, benchmark exposure where applicable (N/A for most internal Tauri paths), update matrix + PROGRESS_LOG + commit/push between meaningful increments.

1. **Highest immediate leverage — Complete the selective split (Item 10 + 2)**  
   Extract a higher-level helper (e.g. `process_post_demosaic_for_mode` or `selective_process_rgb16`) that takes the post-demosaic `rgb16` + lb16 + mode and returns the set of outputs needed (JXL source, thumb, lightbox, etc.).  
   Wire the main `process_file` to call it. This makes the function much cleaner and sets up true flag-based selectivity later.

2. **Strengthen thumb-from-lb everywhere (Item 5)**  
   Audit all derivation sites (thumb, lightbox, any JXL paths). Ensure zero fallbacks to full-res when lb16 is available. Make the "always derive from lb when possible" rule explicit in comments.

3. **Light touch on fixed buffers (Item 9)**  
   Look at the current downscale functions (in Tauri `pipeline.rs` and the ones we added to raw-pipeline). Introduce optional pre-allocated output buffers or a small fixed strategy for the common 1800/360 sizes. Keep it surgical — do not over-engineer.

4. **Optional: Add a true "metadata-only" or "thumb-only" variant of the main command**  
   Useful for gallery prefetch/batch scenarios. Can return early without touching tone/JXL at all.

5. **Always at the end of a slice:**
   - Update `FEATURE_PARITY_MATRIX.md` (change 🟡 notes, summary section).
   - Append a concise entry to `PROGRESS_LOG.md` (TEMPLATE style: scope, changes, verification, docs).
   - Commit only intended files (this repo + sibling `raw-converter-tauri`).
   - Push to `origin/finishing_feature_parity`.

**Do not touch** (per explicit prior directive):
- B5 (true in-flight Rust decode preemption / cooperative yield points inside spawn_blocking).
- C2 (JXTC container on native/jxl-native).
- C3 (progressive/streaming/preview-first encode on native during RAW ingest).
- Any M3 Advanced Controls (Full Modular, Gain Maps, Patches, etc.).

## Key Files (Tauri / RAW side)

**Primary working files (sibling repo):**
- `raw-converter-tauri/src-tauri/src/pipeline.rs` — main `process_file`, the new `tone_and_orient_for_mode` helper, `get_orf_thumb`, `ProcessingMode`, downscale sites, `apply_look_inner` / `Rgb16State`.
- `raw-converter-tauri/src-tauri/src/lib.rs` — command registration.
- `raw-converter-tauri/raw-pipeline/src/pipeline.rs` — shared helpers we added (`downscale_rgb*`, `target_dims`, `apply_look_params`).
- `raw-converter-tauri/raw-pipeline/src/tiff.rs` — B4 public `parse_orf_metadata` + `bench_decode_orf` + `OrfMetadata`/`DecodeBench`.

**This repo (for reference patterns):**
- `src/lib.rs` — WASM `process_orf_with_flags`, `decode_orf_raw`, `process_orf_impl`, `LookRenderer`, `parse_orf_metadata`, `bench_decode_orf`, and the flag constants (`OUT_FULL_RGB8` etc.). Use this as the model for what "selective + clean split" looks like.
- `docs/FEATURE_PARITY_MATRIX.md` and `docs/references/PROGRESS_LOG.md` — always update.

**Reference material:**
- `docs/references/REFERENCE_INDEX.md` — primarily for JXL encoder features (cjxl_main.cc, jpegxl-rs, bridge.cpp patterns). For the current RAW selective work it is only marginally useful (look at high-level API design patterns in jpegxl-rs if you ever touch encode side). The real reference for this bucket is the WASM `src/lib.rs` vs current Tauri implementation.
- Any relevant note files under `docs/references/` for RAW pipeline patterns (internal WASM vs Tauri divergence notes).
- `docs/references/designs/` if any RAW-specific notes exist (most design notes are JXL encoder focused).

## Verification Commands (run after each slice)

- `cargo check` in `raw-converter-wasm` (pulls the sibling raw-pipeline as path dep).
- In sibling: `cargo check -p raw-pipeline` (may hit MSVC/dlltool env issues on this machine — focus on logic).
- Targeted test runs for the affected module.
- Manual inspection of the lightbox/gallery paths if you have the Tauri app running.

## Commit Discipline (non-negotiable)

- Stay on `finishing_feature_parity`.
- Commit + push **between meaningful increments** (exactly as we've been doing).
- Always commit the sibling `raw-converter-tauri` changes too (they live in a separate git repo).
- Only stage the files you actually touched for that slice.

## Open Questions / Tradeoffs to Decide When Continuing

- How aggressive should "thumb" mode be for the final JXL quality? (Current approach accepts a lb16-toned JXL — good enough for gallery prefetch?)
- Should we introduce a real bitmask or enum with more granular output requests (like WASM `OUT_*` flags) instead of the current string `mode`?
- When (if ever) do we want callers that can request *only* metadata or *only* thumb without any JXL at all?
- Item 9 (fixed buffers) — how much do we care about pre-allocation vs. the current rayon par_chunks style for the downscales?

## Final Reminders

- This work is **purely RAW Tauri parity** to close the remaining 🟡 items in matrix Section 1 (after B1–B4).
- Keep changes surgical. Match existing style (especially the helper extraction pattern we just introduced).
- Update the matrix summary section when the "next-set" bucket is closer to complete.
- When this bucket is done, the natural next decision point is whether to tackle the handed-off B5 / C2 / C3 items or something else.

**Good luck — the selective path is in a much better place than when we started the next set.**

---

*Handoff written while context was still ~50%. Recommended to read this + the latest PROGRESS_LOG "Next-set" entry + the current matrix before resuming.*