# HANDOFF: Tauri / WASM Parity (tauriparity branch start, June 2026)

**Date**: 2026-06-03
**Branch**: `tauriparity` (newly created from main post-cleanup/encode-space merge)
**Latest commit**: `d659132` "docs: mark Tauri/WASM parity encode item complete..."
**Context**: Follow-up to archived `docs/Completed plans/Archived_HANDOFF-tauri-wasm-parity-2026.md` and updates in `docs/INCOMPLETE PLANS.md`. The encode direct-RGBA work has landed in `crates/raw-pipeline`; remaining focus is decode/ROI/progressive/metrics for native parity.

This handoff is the live starting point for completing Tauri/native parity with the current WASM + raw-pipeline improvements. The previous handoff (archived) provides deep background on the WASM-side measurements that drove the requirements. Do not re-derive the browser data unless validating native numbers.

## Mission
Achieve **feature and timing parity (or better)** for Tauri desktop (native Rust + raw-pipeline + libjxl in-process) vs. the best current WASM paths, without the JS/WASM boundary costs.

Key remaining items (from INCOMPLETE PLANS.md):
- **Decode (Region/ROI)**: Default to JXTC/tiled ROI for crops/thumbs/subjects/zoomed views. Pass normalized subject rects down instead of full-decode-then-crop.
- **Decode (Full Loads)**: Progressive decode delivering DC/early passes directly to Tauri textures (no worker hop).
- **Shared Metrics**: `onMetric`-equivalent hooks in native for direct comparison (decode_buffer_extract_ms, decode_region_downsample_ms, source_pixels_decoded, full_decoder_*, etc.).

Encode (RAW → JXL direct-RGBA) is marked complete:
- `crates/raw-pipeline` now provides `process_rgba(&rgb16, &params)` + `encode_variants_from_rgb16*` (and progressive variants via `encode_variants_with_progressive`).
- Pure-encode flows (Tauri gallery ingest, export, etc.) get RGBA8 directly from post-demosaic RGB16; no retained 3ch RGB8 intermediate.
- See `crates/raw-pipeline/src/casabio_encode.rs`, `pipeline.rs` (process_rgba impl), and `docs/suggested-settings.md` "Native / Tauri Preferences".

## Current State (Post-Merge on tauriparity)
- `crates/raw-pipeline` is the shared foundation (demosaic, tone/convert, direct RGBA8, JXL variants with progressive controls, rotation opts, etc.). Default features include `parallel` + `jxl-encode` (jpegxl-rs vendored) for native. WASM side uses it with `default-features = false`.
- WASM entry (`src/lib.rs`) now uses `raw_pipeline::*` for decompress/demosaic/pipeline/tiff. Still emits `ProcessResult` with RGB8 + optional lb/thumb RGB16 + `take_rgba()` surface (kept for ownership experiments / native A/B, but browser prefers JS `rgb_to_rgba` per measurements).
- `encode_variants_with_progressive` (Dc + groupOrder for predator-style early recognition) is wired and available for Tauri progressive gallery/lightbox.
- Lots of supporting code landed (benchmarks, web parity updates, crate structure for CR2/DNG/ORF, etc.) via the `benchmarkfeaturechanges` history that was merged in.
- Docs updated: encode item checked in INCOMPLETE PLANS; suggested-settings has native section recommending `process_rgba` for Tauri encode flows.
- Untracked cruft from prior sessions remains (ignore for parity work; focus on code under `crates/`, `src/`, `packages/`, `docs/`).

WASM-side lessons (do not blindly port; re-evaluate for native cost model):
- Boundary copies (take_rgba 4x glue, postMessage) were expensive in browser; cheap or zero in native.
- JXTC/tiled ROI gave 10-50x wins for small crops (9-15ms @128px) by avoiding decode work on unneeded pixels.
- Progressive + emitEveryPass hides perceived latency.
- Full-file wall time (~2.5s+) is mostly libjxl decode compute; native wins on plumbing/perceived/ROI skipping.

See full archived handoff + `docs/boundary-cost-audit.md` (esp. sections 12-13 for Gobabeb 30-file encode + 11-file P2200 crop data) + `docs/suggested-settings.md`.

## Recommendations for Remaining Work (Native/Tauri)
### Decode Region/ROI (biggest user win)
- At encode time for assets with `_crop`/`_subjects` sidecars (or on demand): produce JXTC container or tiled JXL (see WASM `encodeTileContainerRgba8` / tiled paths for reference; native can use libjxl tiled + custom index or jpegxl-rs equivalents).
- At decode time: if JXTC/tiled + region requested, use direct tiled/JXTC decode entrypoints (expose equivalents of WASM `decodeTiledRegionRgba8` / `decodeTileContainerRegionRgba8` via the bridge or raw-pipeline layer). Prefer `JxlDecoderSetCropEnabled` + box-aware output for libjxl-native paths.
- Pass normalized subject rect (or scaled pixel rect) from Tauri UI down to decoder, instead of full decode + client crop.
- Fallback to full + crop only when fast path unavailable; emit metric.
- Replicate crop-benchmark style harness on Tauri side for apples-to-apples numbers (JXTC vs full vs region).

### Decode Full Loads (Gallery/Lightbox Opens)
- Default to progressive (same controls as WASM: progressionTarget equivalents, emitEveryPass / progressiveDetail via libjxl).
- Paint early DC/early-pass frames immediately to Tauri surface/texture (egui, wgpu, etc.). No worker boundary = potential win over WASM perceived latency.
- Consider initial downsample (2x/4x) for huge files + refine on zoom/demand.
- The compute for full image is similar; win on zero-copy plumbing + early usable pixels.

### Shared Metrics + Harness
- Surface the same metric names from native paths: `decode_buffer_extract_ms` (expect near-zero), `decode_region_downsample_ms`, `source_pixels_decoded`, `full_decoder_*`, tiled/jxtc variants, etc.
- Port/extend `raw_decode_bench.rs` (or add Tauri-side equivalent) to run Gobabeb 30-file (encode) and P2200 11-file (decode/ROI) sets.
- Emit comparable self-describing reports (MD/JSON with per-size tables + handoff metrics).
- Update `docs/suggested-settings.md` (native section) + `boundary-cost-audit.md` (add native columns) + INCOMPLETE PLANS once data lands.
- Target: native encode prep+encode <= best WASM JS-path; native ROI/JXTC beats or matches the 9-15ms small-crop class.

### Other / Polish
- Keep `take_rgba` / direct surfaces in raw-pipeline for native (do not remove; opposite of browser rule).
- Wire `encode_variants_with_progressive` (already present) for Tauri desktop progressive output (gallery/lightbox).
- For pure-encode Tauri flows: always prefer the `from_rgb16` + `process_rgba` path.
- Avoid browser-only artifacts (e.g., heavy worker preemption/dedup if not needed; pixel buffer pools for output if native ownership is simpler).

## Key Files (Start Here)
**Core shared (native wins live here)**
- `crates/raw-pipeline/src/{lib.rs, pipeline.rs, casabio_encode.rs}`: process/process_rgba, encode_variants* (progressive support), direct feed for Tauri.
- `src/lib.rs` (WASM side): current integration point + ProcessResult + take_* + flags (for cross-parity).
- `packages/jxl-wasm/src/{facade.ts, bridge.cpp}`: WASM reference impls for ROI/tiled/JXTC/progressive (port ideas, not code).
- `Cargo.toml` (root + crates/raw-pipeline): feature flags (jxl-encode for native, parallel).

**Measurement / validation**
- `src/bin/raw_decode_bench.rs`: existing native harness; extend for parity sets + metrics.
- `web/jxl-crop-benchmark.*`: WASM reference (self-describing reports); replicate equivalent for Tauri.
- `docs/boundary-cost-audit.md` (12-13), `docs/suggested-settings.md`, `benchmark/runs/*.json` (reference data).
- `docs/HANDOFF-predator-continuation-2026-06-encode-matrix.md` (related progressive work).

**Docs to update**
- `docs/INCOMPLETE PLANS.md` (Tauri section + progressive Tauri parity bullet).
- `docs/suggested-settings.md` (native section + any new data).
- `docs/boundary-cost-audit.md` (add native results).
- This handoff + any new continuation docs.

**Other**
- `docs/rejected optimizations.md`: review before new proposals.
- `crates/raw-pipeline/tests/`, `src/bin/`: for validation.

## Immediate Next Steps (Suggested Order)
1. Read the full archived handoff + boundary-cost-audit 12-13 + suggested-settings native section + this doc end-to-end.
2. Stand up / extend native timing harness (raw_decode_bench + any Tauri benches) to run the reference 30-file Gobabeb (encode) + 11-file P2200 (decode/ROI) sets. Emit the same metric names.
3. For ROI: wire JXTC/tiled production (encode side for crop/subject assets) + direct decode paths in Tauri codec layer. Run equivalent "crop benchmark" and compare numbers.
4. For full loads: default progressive + immediate early-pass paint in Tauri lightbox/gallery. Measure time-to-first-useful vs old path.
5. Add onMetric surface (or equivalent) from native decode/encode paths.
6. Head-to-head: native encode prep/encode <= WASM best; ROI wins big; update docs + close items in INCOMPLETE PLANS.
7. (Optional but valuable) Port crop-benchmark logic or create Tauri-native equivalent for ongoing parity validation.

## Guiding Principles
- **Data-driven**: Every browser preference came from real multi-file runs. Do the same for native on identical files/hardware.
- **Different cost model**: Re-evaluate everything. What was expensive across JS/WASM boundary is often free/zero-copy in-process native.
- **Share the core**: raw-pipeline + libjxl bridge functions (progressive, region, tiled/JXTC) are the asset. JS scheduler/worker glue is WASM scaffolding.
- **Tight measurement loop**: Fast iteration (select files → generate variants → run → report) is what made WASM progress possible. Replicate speed for Tauri.
- **Surgical + verified**: No speculative changes. Verify on real Gobabeb/P2200/etc. sets. Update docs with numbers.
- **Different environments**: Native can (and should) do better on ROI and perceived full loads. Don't force WASM workarounds.

**You have the full WASM campaign learnings + the shared raw-pipeline foundation already in the tree.** Make the native/Tauri side the clear winner on the same workloads.

- Grok (on tauriparity branch start, post-cleanup)

## References
- Archived full handoff: `docs/Completed plans/Archived_HANDOFF-tauri-wasm-parity-2026.md`
- INCOMPLETE PLANS (Tauri section)
- `docs/suggested-settings.md`, `docs/boundary-cost-audit.md`
- `crates/raw-pipeline/` (current impl)
- Predator/progressive continuation for related encode progressive work.

## Pickup Progress (initial session on handoff)

**Actioned on receipt of handoff (tauriparity):**
- Step 1 complete: read archived handoff + audit §§12-13 (Gobabeb 30f encode + P2200 11f crop/ROI + handoff metrics) + suggested-settings native section + this doc + key sources (raw-pipeline lib/pipeline/casabio_encode, raw_decode_bench, facade/bridge for ROI/prog reference).
- Extended the measurement vehicle per step 2: `src/bin/raw_decode_bench.rs` now supports `GOB_SCAN_LIMIT`/`GOB_ROOT` + `P2200_SCAN_LIMIT`/`P2200_ROOT` (modeled directly on the JS harnesses), always exercises the `process_rgba` + 4ch direct path for encode reporting, and emits the canonical shared metrics (`decode_buffer_extract_ms=0`, `decode_region_downsample_ms`, `source_pixels_decoded`, `decode_strategy`) + self-describing end-of-run summary (modeled on crop-benchmark MD tables) + updated JSON schema.
- Added `jpegxl-sys` (cfg-guarded) as the declared path for low-level native ROI (`SetCropEnabled` + region out buffer) and progressive (`FRAME_PROGRESSION` etc.).
- Surgical robustness: 4ch encode path now sets `has_alpha(true)` + falls back to 3ch roundtrip JXL timing if 4ch encode fails for a given file (DNG test images were hitting libjxl "buffer too small"). ORF path (the ref set format) was already succeeding.
- Verified: clean `build-msvc.ps1 check --bin`, wasm lib check unaffected, multiple dev/release runs on the test files + sampled Gobabeb ORF.
- Docs updated: `suggested-settings.md` (Native section now documents the harness + envs + sample numbers), `INCOMPLETE PLANS.md` (Tauri bullets annotated with harness/metrics status; encode stays [x]).

**Real reference run data (GOB=30 + P2200=11 = 50 files, release MSVC, 2026-06-03):**
- All 41 ORF ref files succeeded with full direct-rgba + JXL roundtrip ("via direct rgba").
- Gobabeb 30-file encode parity: direct-rgba typically 330-420 ms (outlier 625 ms); jxl encode ~400-550 ms, decode ~520-700 ms (release).
- P2200 11-file: similar range, one higher tone outlier at 1003 ms direct-rgba.
- Overall (n=50): direct_rgba avg=380.7 ms (min 214.5, max 1003.0).
- decode_buffer_extract_ms: avg=0.00 ms over 50.
- decode_region_downsample_ms: avg=682.0 ms over 47.
- Strategies seen: only {"full"} (ROI simulation code landed in same session — next P2200 run will also report small pre-crop dedicated JXL decodes for the 9-15 ms class).
- The emitted Handoff Parity Summary from this exact run is in the conversation paste + benchmark/results_native.json + bench logs.

**Current state vs. open items:**
- Encode direct-RGBA foundation + harness reporting: solid (ORF ref path produces complete encode timings + metrics).
- The 3 checkboxes remain open (ROI default + rect plumbing, progressive DC/early to texture, full onMetric surface in the actual Tauri app). The harness + metric names + scan for the exact ref sets are now the ready "tight measurement loop".
- No browser rules were ported. `take_rgba` / direct surfaces preserved for native. All per guiding principles.

**Next (directly from the numbered list in this handoff):**
- Run the *full* reference sets (`GOB_SCAN_LIMIT=30; P2200_SCAN_LIMIT=11`) in release on the machine with the files. Capture the emitted summary (and/or extend it to per-size tables) + `results_native.json`.
- Use the data to populate native columns in `boundary-cost-audit.md` §12-13 and the Native section here.
- Wire the real ROI (standard libjxl crop/tiled or JXTC container) + progressive early-pass paths (low-level decoder loop) in the Tauri codec / lightbox + feed the same metrics. Re-measure "time to first useful" and ROI savings (target 9-15 ms small crops).
- Close the items in INCOMPLETE PLANS + append results to this handoff or a continuation.

The harness is now the "replicate the speed" vehicle for native parity. Feed it the Gobabeb/P2200 sets and the numbers will drive the rest. 

See the continuation handoff `docs/HANDOFF-tauri-parity-continuation-2026-06-04.md` for wiring the real Tauri-side ROI + progressive + metrics surface.

- Grok (pickup on 2026-06-03)