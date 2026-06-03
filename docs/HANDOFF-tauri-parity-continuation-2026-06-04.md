# HANDOFF: Tauri / WASM Parity Continuation – ROI + Progressive Wiring (June 2026)

**Date**: 2026-06-04 (follow-up to 2026-06-03 run)
**Branch**: `tauriparity` (continuing from the harness + metrics + small-crop simulation work)
**Context**: The previous session landed:
- Full reference harness support (`GOB_SCAN_LIMIT=30`, `P2200_SCAN_LIMIT=11`) in `src/bin/raw_decode_bench.rs`.
- Direct-rgba + 4ch encode always-on for native encode parity reporting.
- Shared handoff metrics (`decode_buffer_extract_ms=0`, `decode_region_downsample_ms`, `source_pixels_decoded`, `decode_strategy`) + self-describing end-of-run "Handoff Parity Summary".
- DNG test file robustness (aligned dimensions from `dng::align_to_rggb`).
- ROI simulation (pre-cropped 128/256 px dedicated small JXLs for P2200 files) producing sub-2 ms decode times (0.5–1 ms @128 px, 1.4–2.8 ms @256 px) — already beating the WASM JXTC 9-15 ms target for small crops from the crop benchmark.
- `jpegxl-sys` (cfg-guarded) declared for low-level work.
- Updated docs + report in `docs/outputs/tauri/gob30-p2200-11-native-parity-2026-06-03.md`.

Encode direct-RGBA (`process_rgba` + `encode_variants_from_rgb16*` with progressive) is solid. The harness now gives apples-to-apples numbers on the real Gobabeb/P2200 sets.

This continuation handoff focuses on the remaining three open items from INCOMPLETE PLANS / the original handoff:
- **Decode (Region/ROI)**: Real (not simulated) fast path in the Tauri codec.
- **Decode (Full Loads)**: True progressive DC/early-pass painting directly to Tauri surfaces.
- **Shared Metrics**: Surface the metric names from the actual Tauri image pipeline / lightbox (so the bench or a Tauri-side collector can emit them for comparison).

## Mission for This Slice
Wire the **real** native/Tauri implementations for ROI and progressive full loads (using the shared `raw-pipeline` for encode-side prep and `jpegxl-sys`/`jpegxl-rs` for decode). Surface the same `onMetric` names. Re-run the reference sets, capture fresh summaries, demonstrate native beating or matching the WASM best-case numbers (especially the 9-15 ms small-crop class and perceived full-load latency), update docs, and close the three checkboxes.

Do **not** re-derive browser numbers. Use the data already in `boundary-cost-audit.md` §12-13 and the previous run summaries. Re-evaluate everything for the native cost model (in-process, zero-copy to textures, direct Rust ownership).

## Current State (Post 2026-06-03 Harness Work)
- `crates/raw-pipeline` provides the shared encode foundation (`process_rgba` for direct 4ch feed into jpegxl-rs, `encode_variants_with_progressive` for Dc/groupOrder/predator-style early recognition). WASM side uses it with features disabled.
- Bench is the measurement vehicle: runs the 30+11 sets, reports direct-rgba prep, full roundtrips via direct path, handoff metrics, and (when P2200 scan enabled) the small pre-crop simulation numbers.
- Tauri app already has some native JXL/RAW paths (uses `jpegxl-rs`, `jpegxl-sys`, `jxl-oxide`; has a low-level progressive-DC sketch in `src-tauri/src/bench.rs` per the progressive implementation note).
- No real region/crop plumbing or stateful progressive decoder is wired into the main Tauri lightbox/gallery/ingest paths yet (they likely fall back to full decode + egui crop or one-shot).
- Metrics surface is only in the bench today (not yet emitted from the production Tauri decoder paths).

## Recommendations (Native/Tauri – Different Cost Model)
- **Encode side for ROI assets**: When you have `_crop`/`_subjects` sidecars (or user-initiated focal regions) at ingest/export time, after `raw_pipeline::process_rgba`, crop the rgba8 and produce additional small dedicated JXLs (or a tiled/JXTC container). This is the "pre-produced region JXL" path that gave us the 0.5–1 ms 128 px numbers in simulation. Store them alongside the full JXL (or embed via custom boxes / sidecar). The bench simulation already proves the decode win.
- **Decode side for ROI**: Prefer libjxl native crop/tiled paths over full-then-crop in egui. Use `jpegxl-sys` directly for `JxlDecoderSetCropEnabled` + sized `JxlDecoderSetImageOutBuffer` (or the existing bridge-style region fns if you vendor/port them). For assets that have the smart container, parse only the relevant tiles/streams. Pass a normalized rect (or pixel rect at the decode resolution) from the UI layer instead of "decode everything then crop".
- **Progressive full loads**: Do **not** use the high-level one-shot `jpegxl-rs::decode`. Build a small stateful wrapper around `jpegxl-sys` (as recommended in `Tauri-progressive-implementation.md`):
  - Keep `JxlDecoder*` alive across incoming chunks (Tauri command can stream bytes or use a growing buffer).
  - `JxlDecoderSubscribeEvents` for `JXL_DEC_FRAME_PROGRESSION` (and basic info, etc.).
  - `JxlDecoderSetProgressiveDetail` (kPasses or kDC).
  - On `JXL_DEC_FRAME_PROGRESSION` / after more input: `JxlDecoderFlushImage`, copy the current image buffer (RGBA8 or whatever format), emit to UI.
  - Paint the DC/early pass immediately to egui/wgpu texture. Refine on subsequent events. No worker hop = lower perceived latency than even the best WASM progressive path.
- **Metrics**: Instrument the real decoder (both ROI and progressive paths) with the exact names the bench already emits:
  - `decode_buffer_extract_ms` (near-zero or final blit cost)
  - `decode_region_downsample_ms` (the libjxl work for the requested pixels)
  - `source_pixels_decoded` (the actual area processed – this will be the win for ROI)
  - `full_decoder_*` variants if you keep a full path for comparison
  - `tiled_*` / `jxtc_*` when using those containers
  - `time_to_first_pixel_ms` or equivalent for progressive
  A simple callback or a thread-local / per-session collector is enough. The bench can stay as the harness; Tauri can log them or expose a "collect metrics" command for A/B runs.
- Avoid browser-only scaffolding (heavy preemption/dedup, pixel buffer pools for transferred buffers, etc.). Native ownership is simpler.

## Key Files & Cross-References (Start Here)
**Shared / measurement (already in tree)**
- `src/bin/raw_decode_bench.rs` (the harness – extend it if you want a "native region decode" entry point that the Tauri side can also call for validation).
- `crates/raw-pipeline/src/{pipeline.rs, casabio_encode.rs}` (process_rgba + progressive encode variants).
- `docs/HANDOFF-tauri-parity-2026-06-03.md` + the new report in `docs/outputs/tauri/`.
- `docs/boundary-cost-audit.md` §12-13, `docs/suggested-settings.md` (Native section).

**Tauri app side (the real work for this slice)**
- `src-tauri/src/` (the Tauri Rust crate – this is where the codec lives).
- Existing progressive sketch: `src-tauri/src/bench.rs` (use as starting point for the stateful decoder).
- Image pipeline / lightbox / gallery ingest code (where RAW→JXL and JXL decode for display happen).
- Sidecar / metadata handling for `_crop` / `_subjects`.

**Low-level JXL (Tauri already has the crates)**
- `jpegxl-sys` (for the state machine, SetCropEnabled, FlushImage, progressive events, SetImageOutBuffer).
- `jpegxl-rs` (high-level one-shot is fine for some paths; do not use it for the hot progressive/region paths).
- Port or re-implement the JXTC container logic from `packages/jxl-wasm/src/bridge.cpp` (the 32-byte header + per-tile index + independent codestreams) if you want exact parity with the WASM "fast ROI" assets. Or use libjxl's native tiling features + crop.

**Docs to update when data lands**
- `docs/INCOMPLETE PLANS.md` (mark the three items done, with links to the new numbers and Tauri commits).
- `docs/suggested-settings.md` (extend Native section with real ROI/progressive timings + "prefer X for Y" rules).
- `docs/boundary-cost-audit.md` (add native columns / tables next to the WASM §12-13 data).
- This handoff + a final summary report in `docs/outputs/tauri/`.
- `Tauri-progressive-implementation.md` (mark the progressive part done).

## Instructions: Creating a New Summary Output (for docs / handoff updates)
Before starting implementation or after a measurement run, capture a clean, timestamped summary so the numbers are preserved and can be pasted into docs.

1. Ensure the reference files exist on disk (Gobabeb 30 ORFs + the 11 P2200*.ORF files from the herbarium collection). Defaults are under `C:\995\2026-02-20 Gobabeb To Windhoek`. If they are elsewhere, set the roots:
   ```powershell
   $env:GOB_ROOT = "C:\path\to\your\gobabeb"
   $env:P2200_ROOT = "C:\path\to\your\p2200"   # falls back to GOB_ROOT if not set
   ```

2. (Optional but recommended for fast iteration) Skip the small hardcoded test files:
   ```powershell
   $env:SKIP_INITIAL_TEST_BENCHES = "1"
   ```

3. Set the reference scan limits (these trigger the Gobabeb encode parity + P2200 full + ROI simulation paths):
   ```powershell
   $env:GOB_SCAN_LIMIT = 30
   $env:P2200_SCAN_LIMIT = 11
   ```

4. Run via the MSVC helper (this ensures the right toolchain + vendored libjxl):
   ```powershell
   .\build-msvc.ps1 run --bin raw_decode_bench --release 2>&1 | Tee-Object "benchmark/results_native_$(Get-Date -Format 'yyyy-MM-dd_HH-mm-ss').log"
   ```
   - The console will show per-file detailed output (RAW stages + direct-rgba + jxl encode/decode).
   - At the very end you will see the full `=== Handoff Parity Summary ...` block (includes the small-crop section when P2200 files were processed).
   - `benchmark/results_native.json` is also overwritten with the structured rows (good for later analysis).

5. After the run:
   - The `.log` file contains everything (timings + the exact summary text the handoff/docs want).
   - Rename or copy the summary section + key aggregates into `docs/outputs/tauri/` (e.g. `native-parity-gob30-p2200-11-2026-06-04.md`) or directly into the handoff continuation.
   - Update `suggested-settings.md` (Native section) and `boundary-cost-audit.md` with tables comparing the new native numbers to the WASM baselines from the audit.
   - Commit the log + JSON snapshot if you want a permanent record for the PR.

6. To re-run just the ROI simulation numbers quickly (no need for all 41 files every time):
   ```powershell
   $env:SKIP_INITIAL_TEST_BENCHES = "1"
   $env:P2200_SCAN_LIMIT = 3   # or 11 when you want the full set
   # (leave GOB at 0)
   .\build-msvc.ps1 run --bin raw_decode_bench --release
   ```

This process is the "tight measurement loop" the original handoff asked for. Do it after every meaningful wiring change on the Tauri side.

## Immediate Next Steps (Suggested Order)
1. Read this handoff + the progressive implementation note end-to-end + the current state of `src-tauri/src/bench.rs` (the low-level sketch).
2. On the encode side (Tauri ingest / gallery import paths that already call raw-pipeline):
   - When a file has known crop/subject rects, after `process_rgba` also produce + store small dedicated JXLs (or start emitting a simple tiled/JXTC container). Use the same `encode_small_rgba_jxl`-style or the progressive-aware `encode_variants_with_progressive`.
3. Implement the stateful native JXL decoder (recommended shape from the progressive doc + ROI needs):
   - Small module (e.g. `src-tauri/src/jxl_decoder.rs`) that owns a `*mut JxlDecoder`, subscribes to the right events, supports both "full progressive" and "region + progressive" modes.
   - `set_region(normalized_rect or pixel rect)` or pass it at construction / decode start.
   - For progressive: on `FRAME_PROGRESSION` call `FlushImage`, copy the current buffer (respect crop if set), emit via Tauri event or callback (RGBA8 or the format your texture wants).
   - For ROI: call `JxlDecoderSetCropEnabled` + size the output buffer to the crop before processing. This is what will give you the real (not simulated) sub-10 ms small crops on a smart-encoded asset.
   - Support JXTC if your assets will use the container (parse header/index, feed only the overlapping tile bitstreams to independent decoders or a single decoder with seeks).
4. Expose Tauri commands / Rust functions that the frontend can call:
   - `decode_jxl_for_display(path, region: Option<Rect>, progressive: bool, on_frame: ...)` or similar.
   - Return early frames for progressive, or the region crop directly.
5. Wire the calls from the existing Tauri image pipeline / lightbox / thumb generation:
   - For subject focus / crop thumbs / zoomed lightbox: compute the rect from the sidecar or current viewport, pass it down.
   - For gallery open / full load: request progressive + no region (or downsample 2x/4x initially).
   - Replace any "decode full then crop in egui" or repeated prefix re-decode loops.
6. Add metric emission from the new decoder (same names the bench already knows). A simple `on_metric(name: &str, value: f64)` callback or a small collector struct is enough. Make sure the bench (or a Tauri-side test harness) can consume them for the next ref run.
7. Rebuild Tauri, run the full GOB=30 + P2200=11 measurement (using the instructions above). Capture the new summary (now with real ROI times instead of just the simulation).
8. Populate the audit / suggested-settings with the fresh native numbers. Demonstrate native ROI << WASM full, and progressive perceived latency better than the best WASM path.
9. Update INCOMPLETE PLANS (mark the three items [x] with links), append results + wiring notes to this handoff or a final summary, close the loop.

## Wiring Notes for the Tauri Side (Concrete)
**Encode (ingest / export / gallery import that already touches RAW):**
```rust
// After you have rgb16 + PipelineParams from raw_pipeline
let rgba = raw_pipeline::pipeline::process_rgba(&rgb16, &params);

// Full variants (as today)
let variants = raw_pipeline::casabio_encode::encode_variants_with_progressive(
    &rgba, w, h, SourceType::Raw, hq, progressive_dc, group_order
)?;

// For ROI assets (when you have a subject rect from sidecar or user)
let subject_rect = ...; // normalized or pixel rect at full res
let (sx, sy, sw, sh) = compute_pixel_rect(subject_rect, w, h);
let crop = crop_rgba(&rgba, w, h, sx, sy, sw, sh);  // simple helper like the one in the bench
let subject_jxl = encode_small_rgba_jxl(&crop, sw, sh)?;  // or full encode_variants on the crop
// Store subject_jxl keyed by the rect (or embed in the asset).
```
Later you can evolve this to a proper tiled or JXTC writer using `jpegxl-sys` encoder frame settings or multiple independent codestreams + index.

**Decode (the hot path that needs the stateful wrapper):**
```rust
// Pseudocode – put this in a stateful struct behind a Tauri command
let dec = unsafe { JxlDecoderCreate(...) };
unsafe { JxlDecoderSubscribeEvents(dec, JXL_DEC_BASIC_INFO | JXL_DEC_FRAME_PROGRESSION | ... ) };
if let Some(region) = requested_region {
    unsafe { JxlDecoderSetCropEnabled(dec, JXL_TRUE, region.x, region.y, region.w, region.h) };
}
unsafe { JxlDecoderSetProgressiveDetail(dec, JxlProgressiveDetail::kPasses) };
// feed bytes (from file or stream)
loop {
    let status = unsafe { JxlDecoderProcessInput(dec) };
    match status {
        JXL_DEC_FRAME_PROGRESSION => {
            unsafe { JxlDecoderFlushImage(dec) };
            // copy current image buffer (size respects crop if set)
            let frame = extract_current_rgba(dec);
            emit_to_ui(frame);   // paint to egui/wgpu texture immediately
        }
        JXL_DEC_FULL_IMAGE => { /* final */ break; }
        ...
    }
}
```
For JXTC assets, before the loop: parse the 32-byte header + index, then only feed the byte ranges of the overlapping tiles (each tile is an independent JXL codestream – you can even decode them in parallel or sequentially into the right place in the output buffer).

**Metrics emission:**
Inside the decoder (on each event or at the end of a stage):
```rust
on_metric("decode_region_downsample_ms", elapsed_ms);
on_metric("source_pixels_decoded", (crop_w * crop_h) as f64);  // or full if no crop
on_metric("time_to_first_pixel_ms", time_to_first);
```
Wire `on_metric` to whatever collector the bench or your A/B harness uses (same names as the WASM facade / crop benchmark).

**UI / call sites (the places that currently do full decode or full-then-crop):**
- Lightbox open with subject: compute rect from sidecar, call the region+progressive decoder.
- Thumb generation for subjects: use the pre-produced small JXL or a 128 px region decode.
- On zoom/pan: if the change is significant, compute new visible region and re-decode only that (or refine the existing decoder state if you keep it alive).
- Gallery grid: can use small pre-produced or aggressive downsample + progressive.

Keep the existing one-shot paths as fallbacks (emit a metric when you fall back so you can see how often the fast path is available).

## Guiding Principles (Carry These Forward)
- Data over taste: After wiring, run the full reference sets again and let the new numbers (especially the real ROI times vs the previous simulation) drive any tuning.
- Share the core: raw-pipeline for the tone/convert step that feeds both full and small-crop encodes. The low-level libjxl state machine lives in Tauri (where it can paint directly).
- Surgical + verified: Port the minimal state machine needed. Verify every change on the real 30+11 files. Update the summary + audit every time.
- Different cost model: You can keep the decoder state alive, zero-copy into textures, paint partial buffers synchronously from Rust – none of the JS/WASM/transfer taxes apply.

**You now have the harness, the metrics, the encode foundation, and a working simulation that proves the target is achievable. Wire the real thing in the Tauri codec, measure, and close the loop.**

## 2026-06-04 Actions & Analysis from Supplied Timings (results_native.json + log)
- Performed full read of this handoff, prior handoff, Tauri-progressive-implementation.md, bench, audit §12-13, suggested-settings Native, INCOMPLETE PLANS (per Immediate Next Steps).
- Analysis of provided data (generated 2026-06-03T14:36:34Z):
  - direct_rgba (full tone step): 263.4 ms avg / min 234 (n=41). Native cost model different from WASM ~65 ms glue-only.
  - extract: 0.00 ms (win vs WASM 3.8 ms in §13).
  - full downsample: 428.8 ms (vs WASM full 2.5-2.9 s in crop benchmark).
  - Pre-crop simulation (proxy for ROI assets): 0.8 ms avg @128 px (min 0.5) / 2.1 ms @256 px over 11 files — **already 6-30x under the WASM JXTC 9-15 ms target**.
- Action: wired real low-level stateful progressive (jpegxl-sys: Subscribe + SetProgressiveDetail(Passes) + ProcessInput loop + FlushImage on FrameProgression + SetImageOutBuffer) in `src/bin/raw_decode_bench.rs` (bench_jxl_decode_lowlevel_*). Exercised on P2200 refs during verification (P2200=1); first-pixel for full loads reported (~half total in run). Lowlevel full decode path also present. Prints + collection now feed end-of-run summary. (No SetCropEnabled in vendored 0.10 — pre-crop asset path + lowlevel decode on small codestreams is the fast ROI; native-crop rows deferred to when binding or JXTC lands.)
- Produced `docs/outputs/tauri/gob30-p2200-11-native-parity-2026-06-04.md` (full analysis + verbatim supplied summary + next steps).
- Updated `docs/boundary-cost-audit.md` §13 (Native results subsection + comparison), `docs/suggested-settings.md` (Native section with achieved numbers + "use lowlevel prog for full, pre-crop assets for ROI"), `docs/INCOMPLETE PLANS.md` (Tauri decode bullets annotated with harness status + links; no src-tauri present in workspace so no direct edits there).
- Verification: MSVC check clean; limited ref run (SKIP + P2200=1) executed new paths, produced first < total, summary extended, no crashes.
- The three checkboxes remain open (real Tauri codec integration + sidecar JXTC/small emit + production metric emission from Tauri lightbox/gallery are the missing piece; this workspace supplies the shared pipeline, low-level model, harness, and numbers to drive it).

- Grok (continuation after the 2026-06-03 harness + simulation session)

## References
- Previous handoff + progress: `docs/HANDOFF-tauri-parity-2026-06-03.md`
- Progressive sketch & recommendation: `Tauri-progressive-implementation.md`
- WASM reference impls for the shapes to match: `packages/jxl-wasm/src/{facade.ts, bridge.cpp}` (region, tiled, JXTC, progressive events)
- INCOMPLETE PLANS (Tauri section)
- `docs/suggested-settings.md` (will need the final native rules after measurement)
- `docs/boundary-cost-audit.md` §12-13 (the WASM baselines to beat)
- The updated bench + small-crop helpers in `src/bin/raw_decode_bench.rs` (use as a model or even call into a shared native decode helper if you factor one out)