# Suggested Settings — RAW Pipeline + JXL Encode (Browser/WASM)

**Date**: June 2026 (updated for P3.3 close-out)  
**Status**: Current recommendation after Boundary Cost Audit + 30-file Gobabeb verification (encode boundary) + 11-file crop benchmark (decode/region boundary) + handoff timing instrumentation + legacy cleanup.

## Core Recommendation (Browser / Web)

For all browser/WASM usage of the RAW decode → JXL encode pipeline:

**Prefer the JS-side conversion path:**

```js
const rgba = rgb_to_rgba(result.take_rgb());
// or the safe fallback form used throughout the codebase:
const rgba = (typeof result.take_rgba === 'function')
    ? result.take_rgba()
    : rgb_to_rgba(result.take_rgb());
```

**Do not prefer `result.take_rgba()` or `result.rgba()` for new or hot paths in the browser.**

### Why

Multiple rounds of measurement on real Gobabeb (and other) files using the high-fidelity `session-worker-timings` harness showed a consistent regression when using the WASM-side `take_rgba()` path:

- 30-file Gobabeb verification (browser + real WASM): `take_rgba` was **+10.5 ms mean / +13 ms median** slower on `rgbaPrepMs`, leading to **~+230–260 ms slower end-to-end** per file (~4–5%).
- Profiling with fine-grained breakdown (`rgbaPrepBreakdown`) + post-prep handoff timings (`postRgbaPrepMs`, `rgbaExactBufferMs`):
  - The entire regression lives inside the `take_rgba()` WASM call + wasm-bindgen glue copy-out of the 4× buffer.
  - Post-prep handoff costs (`exactBuffer` before `pushPixels`, resize) were **negligible (~0 ms)** in both paths for typical Gobabeb workloads (max edge = Infinity).
- Earlier Node-targeted harness numbers had shown a small win for `take`; the real browser environment (V8 + wasm-bindgen + actual session/encode pipeline) did not.

**Primary hot spots in the WASM path** (identified via instrumentation):
1. Rust allocation of the output RGBA `Vec<u8>` (4 bytes/pixel).
2. The conversion loop running inside WASM.
3. The mandatory full copy in the glue (`getArrayU8FromWasm0(...).slice()`) on a ~76 MiB buffer for a 24 MP image.

The JS path wins because:
- `take_rgb()` moves a smaller 3× buffer.
- The actual RGB→RGBA conversion runs in highly optimized V8 code on data the JS side already owns.

## When the WASM-side Methods May Still Have Value

- **Tauri / native contexts**: The cost model is completely different (no JS/WASM boundary for the conversion itself in the same way). Keep the methods available.
- **Future Phase 2B experiments** ("direct RGBA production inside the raw-pipeline tone/convert stage"): The `take_rgba` / `rgba` surface provides a natural place to experiment with a `take_rgba_direct()` variant without changing every call site immediately.
- **Lab / debugging / A/B testing**: The `RAW_RGBA_MODE=js|take|direct` harness (in `session-worker-timings*` and `targeted-wasm-timings`) was extremely valuable for discovering the truth. The methods enable that infrastructure.
- **Ownership handoff in pure-encode paths**: `take_rgba()` returns a buffer the caller can transfer without the JS side ever materializing a full 3× RGB buffer. In theory this reduces peak memory and GC pressure for "decode RAW → immediately encode JXL, discard RGB" flows. In practice on browser workloads, the conversion cost dominated any such benefit.

## If We Remove `take_rgba()` and `rgba()` Entirely

### What We Gain (Leanness + Simplicity)
- Remove two methods (`take_rgba`, `rgba`) from `ProcessResult` in `src/lib.rs`.
- Remove the associated (now very small) test.
- Remove or greatly simplify the `RAW_RGBA_MODE` / `takeRgbaForMode` machinery in the benchmark harnesses (`session-worker-timings-browser.js`, `targeted-wasm-timings.mjs`, etc.).
- Slightly smaller public API surface and WASM binary.
- Less cognitive overhead: one fewer "which conversion path should I use?" question for new developers.
- The safe-fallback ternary pattern (`typeof result.take_rgba === 'function' ? ...`) can eventually be cleaned up in many places once the methods are gone.

### What We Actually Lose
- **The ownership / boundary-crossing experiment hook** — `take_rgba()` was the concrete artifact of the "move work across the JS↔WASM boundary to reduce copies" idea from the Boundary Cost Audit. Removing it closes off easy future attempts at this style of optimization for this specific conversion without re-adding the methods.
- **Historical A/B testing capability** for this exact boundary. The harness that proved the JS path was better would become harder to run.
- **Any (currently unmeasured) win in non-browser environments** (Tauri, Node without the full browser cost model, etc.).
- **A small amount of future-proofing** for a hypothetical world where WASM execution or glue costs improve dramatically relative to V8 loops.
- **The `rgba()` borrow variant** (less used, but occasionally convenient in lab code that wants to keep the original `ProcessResult` alive).

**Net assessment (June 2026)**: On current evidence, we lose very little *performance* in the dominant browser use case by removing the preference for (or the methods themselves). The "leanness" win is real and the risk of keeping a slower path as the "modern" option is higher than the theoretical future upside.

## Current Call Site Guidance

All high-value call sites have been cleaned up (June 2026) to use the recommended direct JS conversion path. The safe-fallback ternaries and the entire `RAW_RGBA_MODE` A/B testing machinery in the benchmark suite have been removed. The rotation path in `web/worker.js` correctly remains on the RGB path because it must call `rotate_rgb8`.

Recommended pattern going forward (new code):

```js
// Preferred for browser paths
const rgba = rgb_to_rgba(result.take_rgb());
```

The old "take-first" pattern should only be used when:
- The caller is in a Tauri/native context and has measured a win, **or**
- You are explicitly doing A/B testing with the harness.

## Decode Strategy (Region/Crop vs Full Loads) — P3.3 Crop Benchmark (June 2026)

From the 11-file / 55-sample crop benchmark (P2200*.ORF set, varied content, tile=128px, sizes 128–2048px) + supporting single-file runs:

**For crops, thumbnails, subject zooms, lightbox focal regions, or any ROI**:
- Prefer JXTC (tile container) or tiled region decode when the source JXL was produced with tiles (`encodeTiledRgba8` / `encodeTileContainerRgba8`).
- Call `decodeTiledRegionRgba8` or `decodeTileContainerRegionRgba8` (exposed via raw_converter_wasm and `@casabio/jxl-wasm` facade).
- Data: JXTC 9–15 ms for 128 px crops (up to ~500–870 ms at 2048 px); ~10–50× faster than full-then-crop for small/medium views. Tile region also wins vs full but carries ~1.1–1.5 s overhead vs pure JXTC for small ROIs.
- The pixel handoff/extract cost itself is cheap (~3.8 ms avg `decode_buffer_extract_ms` across 55 samples). The win is avoiding unnecessary WASM decode work for unneeded pixels.

**For full-resolution loads** (gallery grid, lightbox open, export source, progressive paint final):
- Use progressive decode: `progressionTarget: 'final'|'pass'|'dc'`, `emitEveryPass: true` (or low `progressiveDetail`).
- Current production paths already default here: `web/jxl-decode-worker.js` (lightbox/gallery via pool), `web/jxl-progressive.js` stream sessions, etc.
- The ~2.5–2.9 s "long load time for a full file" (up to 3.8 s on some content) is dominated by full WASM decode compute + extract + JS crop. Even passing `region` to the standard progressive decoder often results in full decode then client-side crop (see facade `eventsProgressive` + `applyRegionAndDownsample`; early C++ crop is oneShot-only today).
- Progressive + emitEveryPass gives usable low-res first (DC or early passes), hiding perceived latency while the rest refines.

**Current status of main paths (light exposure)**:
- Lightbox/gallery thumbs + full previews (via `decodeJxl` + jxl-decode-worker) already use progressive + emitEveryPass + `region: null`/`downsample:1`.
- Subject/crop focus in lightbox currently decodes full JXL then zooms/crops on canvas (`decodeFullJxlFor` + focusOnRegion). When encode side starts producing JXTC for assets with `_crop`/`_subjects`, wire the ROI decode at that point.
- The `jxl-crop-benchmark.html` (http://localhost:9000/web/jxl-crop-benchmark.html) is the measurement + validation vehicle; select files, "Generate tiled + JXTC", run comparisons to see Tile / JXTC / Full + the Decode Pixel Handoff metrics table.

**Further analysis / improvement setup** (for after P3.3):
- Extend crop benchmark or add harness to exercise full jxl-session/worker path so `decode_toarraybuffer_ms` (handler) + scheduler costs are captured for region cases.
- Enhance full decode paths with more `full_decoder_*` (create/push/events) + `source_pixels_decoded` to confirm work done.
- Add `emitEveryPass` variant to crop benchmark for DC/pass handoff costs.
- Make standard progressive region cheaper: early crop in C++ (pass region into dec state, or route crops via oneShot when possible) or tighter JS path in `applyRegionAndDownsample`.
- Investigate tile path overhead (tile grid/assembly in facade `decodeTiledRegionRgba8`).
- Default encode paths that know about crops/subjects to emit tiled/JXTC so the fast ROI path is available without extra user steps.
- For initial full views: consider default `downsample: 2|4` + refine on demand.

See `docs/boundary-cost-audit.md` §13 for the full per-size tables, per-file details, handoff metric summaries, and the exact 11-file report that drove these settings.

## Truly-Progressive Web JPEG / RAW Pipeline (SNEYERS_PRESET, 2026-06-03)

Recipe (verified via `benchmark/progressive-flag-matrix.mjs` + `benchmark/jpeg-progressive-stream.mjs`, see docs/Benchmark results/truly-progressive-2026-06-03.md):

| Setting        | Value | Notes |
|----------------|-------|-------|
| progressive    | true  | enables PROGRESSIVE_* flags in bridge |
| previewFirst   | true  | triggers SNEYERS_PRESET branch in resolveEncoderBridgeSettings |
| progressiveDc  | 2     | multi-layer DC pyramid for very-early thumbnail |
| progressiveAc  | 1     | spectral AC progression |
| qProgressiveAc | 1     | quantized AC progression |
| groupOrder     | 1     | center-out — best perceived early quality |
| effort         | 3     | measured best on this codebase; libjxl's ≥7 recommendation does NOT apply here |
| decodingSpeed  | 0     | bias bitstream for decoder speed at progressive boundaries |

Decoder pair:
- `progressionTarget: "final"`
- `emitEveryPass: true`
- `progressiveDetail: "passes"` (kPasses — finest spectral progression)

Result targets (representative file, reference binary): firstRecognizable ≤ 1% bytes, ≥17 paints, monotone PSNR, final PSNR ≥ 40 dB.

Use `createSneyersPreset({ width, height, targetLongEdge, quality })` from `web/jxl-progressive-best-preset.js` to get the full encode+decode triple.

---

## Progressive Encode for Early Recognition (Benchmark + Demo Use)

For the progressive paint/gallery benchmarks (`jxl-progressive-paint.html`, `jxl-progressive-gallery.html`) and any "early usable preview" testing:

**Canonical settings** (use these for multi-layer center-first demos):
- `progressive: true`
- `progressiveDc: 2`
- `groupOrder: 1`
- `previewFirst: true`
- `progressiveDetail: 'passes'` (or `emitEveryPass: true` + detail in decoder)
- `progressiveFlavor: 'ac'` (derived)

**Why**: progressiveDc=2 gives more granular low-frequency stages; groupOrder=1 (center-out) makes the first DC layers start from the middle of the image rather than scanline strips — dramatically more recognizable at low byte counts. Combined they turn the "only two nearly-identical passes" symptom into visibly useful staged reveals (3+ distinct events in some cases; 2 on small 300×225 refs per 2026-06 ref measurement run). 2026-06 measurement on small_file.jpg (q=85): always 2 events surfaced; group=1 gave major encode speed wins at low effort (~5-6× at e=3); Dc=2 cost ~20-25% size with no event count increase on that ref (visual/spatial quality of the early layer is the win). Cost of the SetOption is negligible (one frame setting write). See predator continuation handoff + the predator-progressive-layers-*.json for raw numbers.

**In paint page (6/8 passes + Preview 1st checked)**: now defaults to the above via the new Center-out checkbox + computed Dc (user can uncheck for A/B scanline comparison). Export to gallery pushes the exact codestream for round-robin multi-layer viewing.

**In gallery onfly**: the controls (`gallery-prog-dc`, `gallery-group-order`, `gallery-preview-first`, detail="All passes") drive the same.

See `docs/HANDOFF-predator-progressive-2026.md` (continuation block + progress) and `docs/references/designs/progressive-encode-options.md` for wiring, UI, and measurement notes. Small-ref "first layer" numbers (always 2 events on 300×225 photo; group=1 speed win; Dc=2 size cost; firstBytes==total under chunk feed) captured 2026-06-03 and backfilled here + audit + handoff + outputs report. Automation smoke (tools/predator-paint-visual-smoke + matrix probe) executed: 2 paints, first~443ms, center-bias proxy~18.8 on g=1/passes/preview run. Still need human A/B + cutoff-probe "bytes to recognizable" on larger refs (Gobabeb/P2200).

## Native / Tauri Preferences (Post-P3.3 Parity, June 2026)

The WASM/browser cost model (JS glue copies on 4× return, transfer taxes, etc.) does not apply to direct Rust callers (Tauri desktop using `raw-pipeline` + `jpegxl-rs` in-process).

**For encode (RAW → JXL) paths in Tauri**:
- **Prefer `pipeline::process_rgba(&rgb16, &params)`** (added as part of this parity work) for any flow whose next step is JXL encode (casabio_encode variants, direct jpegxl-rs, export, gallery ingest).
- This is the "Phase 2B direct-RGBA production" experiment, now higher-leverage in native: fuses tone + alpha write, never allocates the 3× RGB8 intermediate owned buffer.
- Wire pure-encode call sites (decode RAW → encode the three JXL variants, discard pixels) to use rgba8 directly with 4-channel encoder frames. Peak memory during ingest drops; one fewer full-buffer pass.
- Keep `pipeline::process` (3ch) for paths that must retain RGB (rotation, further CPU-side editing, LookRenderer consumers that need the 3ch form, etc.).
- Measurement: `src/bin/raw_decode_bench.rs` now runs head-to-head (tone 3ch vs direct rgba) and uses the direct-rgba + 4ch encode path for its reported JXL timings. Emits `directRgbaMs` in `benchmark/results_native.json`.
- Update `docs/suggested-settings.md` (this section) + audit once real Tauri gallery/export numbers on Gobabeb/P2200 sets are captured.

**Do not port the browser rule** ("always prefer JS rgb_to_rgba after take_rgb"). The native rule is the opposite for encode-heavy flows.

**For decode / region / progressive (P3.1–P3.3 parity)**:
- Progressive first-paint (P3.1 equiv): use libjxl's `JXL_DEC_FRAME_PROGRESSION` + `JxlDecoderFlushImage` + `JxlDecoderSetProgressiveDetail` via `jpegxl-sys` (or jpegxl-rs when it exposes) in the Tauri lightbox. Paint DC/early passes to egui/surface immediately. No worker hop = can beat WASM perceived latency. (Bench low-level prog paths wired 2026-06-04; verification: first pixel before full decode on ref full loads.)
- ROI/region (P3.2): use `JxlDecoderSetCropEnabled` + box-aware output buffer sizing for subject focus, zoom/pan, thumbs. Avoid full decode + crop. (2026-06-03/04 harness pre-crop sim + low-level decode already <2 ms @128 px on dedicated assets.)
- JXTC / tiled (P3.3): At encode time for assets with `_crop`/`_subjects` sidecars (or on demand), use libjxl tiled encoding (jpegxl-rs builder or sys) or implement the JXTC custom container (per-tile independent codestreams + 'JXTC' index) in native for 10-50× crop wins on small ROIs (see WASM `encodeTileContainerRgba8` / `decodeTileContainerRegionRgba8` numbers: 9-15 ms @128 px). (Harness simulation already demonstrates the win vs WASM baseline.)
  - Native equivalent of tiled region decode can be direct (no tile-assembly tax if using libjxl's own region + tile cache, or manual for JXTC).
  - Fallback to full + crop only when fast path unavailable; emit metric.
- The custom JXTC container is WASM-bridge specific today; native Tauri can achieve equivalent (or better, zero-copy to texture) using standard libjxl tiled features + `JxlDecoderSetImageOutBuffer` for the ROI rect. Replicate the crop-benchmark harness on Tauri side for apples-to-apples JXTC vs full vs region numbers.
- onMetric parity: surface the same names (`decode_buffer_extract_ms` near-zero in native, `decode_region_downsample_ms`, `source_pixels_decoded`, `full_decoder_*` etc.) from native decode paths.

**Measurement harness for parity**:
- `src/bin/raw_decode_bench.rs` extended (tauriparity) with GOB_SCAN_LIMIT / GOB_ROOT / P2200_SCAN_LIMIT / P2200_ROOT (modeled on JS harnesses), direct-rgba always-on for encode reporting, and handoff metric columns (decode_buffer_extract_ms=0 in native, decode_region_downsample_ms, source_pixels_decoded, decode_strategy) + self-describing summary at end + JSON.
- Run e.g. `$env:GOB_SCAN_LIMIT=30; $env:P2200_SCAN_LIMIT=11; .\build-msvc.ps1 run --bin raw_decode_bench --release`
- Real 50-file reference run (GOB_SCAN_LIMIT=30 + P2200_SCAN_LIMIT=11, release MSVC): direct_rgba avg 263.4 ms (min 234.3, max 398.5) over 41 ORFs in supplied 2026-06-03 timings (prior capture showed ~380 avg; machine/load variance). All ref ORFs produced successful JXL roundtrips via the direct rgba path. decode_buffer_extract avg 0.00 ms. (Compare to WASM JS-path rgbaPrep ~65 ms mean on the 30-file Gobabeb set from audit §12; the native number is the full tone step that produces the 4ch buffer ready for encoder with no extra boundary cost.)
- Small-crop ROI simulation (P2200 11 files): 128 px 0.8 ms avg (min 0.5); 256 px 2.1 ms avg (min 1.3) — already beats WASM JXTC 9-15 ms target.
- Low-level prog first-pixel (stateful, 2026-06-04): verification shows early frame ~half total decode time on full loads.
- Target: native encode prep+encode <= best WASM JS-path numbers (ideally better by saved boundary copies). Native pre-crop/region/JXTC should beat or match the 9-15 ms small-crop class. Prefer low-level stateful prog (jpegxl-sys) for Tauri full gallery/lightbox opens.
- Record results; update this doc + `boundary-cost-audit.md` §12/13 with native columns. See `docs/outputs/tauri/gob30-p2200-11-native-parity-2026-06-04.md` (analysis of supplied timings) + docs/HANDOFF-tauri-parity-2026-06-03.md + continuation.

See HANDOFF-tauri-wasm-parity-2026.md for the full mission and guiding principles.

## Related Documents

- `docs/boundary-cost-audit.md` (especially §12–13 for the 30-file encode boundary + 11-file decode/region P3.3 data; also earlier sections for Tier priorities)
- `docs/HANDOFF-boundary-cost-audit-2026.md`
- `docs/fast-path-principles.md` (historical context on the earlier micro-optimization style)
- `docs/handoff-p3-lightbox-jxl-decoder.md` and P3 planning docs (context for JXTC/ROI as the P3.3 target)

---

*This document records the current engineering preference after extensive measurement. It should be updated when new environments are measured or when a future improvement (e.g., direct production inside raw-pipeline or better glue, or full JXTC integration in gallery) changes the data.*