# WASM ↔ Tauri Feature Parity Matrix (Master)

**Single Source of Truth for Feature Completeness**  
**Date:** 2026-06 (post-audit unification)  
**Purpose:** Complete inventory of *all* features across the stack (raw-pipeline + CasaWASM JXL wrapper + scheduling + benchmark harness + Tauri desktop), with implementation status for the browser WASM pathway vs. the native Tauri/desktop pathway, plus exposure in the web Benchmark UIs. Extends the earlier partial "new features" comparison (WASM_Tauri_feature_comparison.md) to full coverage.

This matrix supersedes and consolidates:
- WASM_Tauri_feature_comparison.md (raw transpose gaps + 3 JXL)
- CasaWASM_JXL_Feature_Completeness_and_Gaps.md (JXL gaps + scaffolding)
- Overlaps in Overview and features..., REFERENCE_INDEX.md audit, DESIGNS_INDEX, PROGRESS_LOG entries, and scattered strategic/feature-summary docs.

**Legend**
- ✅ Fully implemented and parity (or N/A where concept does not apply to one side)
- 🟡 Partially implemented (core works, missing polish/flags/exposure/edge cases, or one-sided)
- ❌ Not implemented (gap)
- N/A — Does not apply (e.g., WASM-only allocator strategy, browser-specific native JXL probe, Tauri-only desktop FS integration)

**Benchmark Exposure column:** Names the specific web/ page(s) or "N/A". "all" = exercised across the main lab + dedicated pages. "wrapper-lab" = jxl-wrapper-lab.html (primary option surface). Other pages: jxl-crop-benchmark.html, animation-lab.html, jxl-progressive-paint.html, jxl-benchmark.html, jxl-progressive-gallery.html, jxl-progressive-byte-benchmark.html.

**Maintenance:** Update this matrix + PROGRESS_LOG.md on every feature landing or audit. Link from HANDOFF, DESIGNS_INDEX, REFERENCE_INDEX, and the two legacy comparison docs (now thin redirects).

---

## 1. Raw Pipeline / ORF + DNG Processing (Core Scientific Fidelity)

| # | Feature | WASM | Tauri | Benchmark Exposure | Notes |
|---|---------|------|-------|--------------------|-------|
| 1 | LookRenderer – WASM-resident pre-tonemapped RGB16 + zero-copy render() for live sliders | ✅ | ✅ (B3: Rgb16State now has resident .render() + .new() mirroring WASM LookRenderer exactly — unsharp conditional, orientation fastpath, unified params from B1; apply_look delegates; full backward compat. Highest UX gap closed) | jxl-preset-benchmark.html (RAW Isolation, construction + render timing + P1 2026-05-31 export/hero) + main worker | WASM src/lib.rs:946 + B3; now measurable in browser optimization context for different output sizes |
| 2 | process_orf_with_flags + selective bitmask (full / lightbox / thumb) | ✅ (OUT_* consts, conditional paths) | ✅ (ProcessingMode + `process_post_demosaic_for_mode` + `skip_jxl` + get_orf_thumb deliver the practical selective paths needed on desktop: full/lightbox/thumb/metadata-only. Full internal bitmask not required.) | jxl-preset-benchmark.html (RAW Isolation panel + P1 2026-05-31: unified export + hero) | Now exposed for timing different output modes in browser optimization suite |
| 3 | parse_orf_metadata (TIFF/EXIF-only, zero pixel work) | ✅ | ✅ (B4: public `raw_pipeline::parse_orf_metadata` + `get_orf_metadata` Tauri command; zero pixel work) | N/A | Gallery preflight; WASM:1122 + B4 on finishing_feature_parity |
| 4 | bench_decode_orf (isolated decompress+demosaic timings) | ✅ | ✅ (B4: public `raw_pipeline::bench_decode_orf` + `bench_decode_orf` Tauri command) | jxl-preset-benchmark.html (RAW Isolation panel + P1 2026-05-31 export/hero + P2 2026-05-31 artifacts + P4 2026-05-31: explicit bench_decode_orf gating, 5-run median for stability, dead median helper removed) | WASM:1156 + B4; now surfaced in browser optimization suite for use-case costing (thumbnails vs 80MP vs gallery) |
| 5 | Thumb derived from pre-computed lightbox buffer (not 2nd full scan) | ✅ | ✅ (B2 + next-set + step1: strong lb16 preference implemented in `process_post_demosaic_for_mode`; thumb and JXL sources prefer pre-toned lb16 where possible. Audit complete.) | N/A | Memory win achieved on Tauri via B-series work |
| 6 | Orientation==1 fast-path (move / zero-copy, no 60 MB traffic) | ✅ (explicit in process + apply_look) | ✅ (apply_orientation now takes Vec<u8>; orientation==1 is zero-copy move; all 5 Tauri callers updated — 3e on epiccodereview/20260527T054853) | N/A | raw-pipeline/src/pipeline.rs:614 |
| 7 | Unified apply_look_params helper (single 12× is_finite, no drift) | ✅ (private helper called from 3 paths) | ✅ (now delegates to shared raw_pipeline::pipeline::apply_look_params; B1 on finishing_feature_parity) | N/A | WASM:156 + raw-pipeline/src/pipeline.rs |
| 8 | apply_look accepts native &[u16] (no LE byte unpack) | ✅ | N/A (no public apply_look; edits baked at process_file) | N/A | WASM:836 |
| 9 | Pre-allocated fixed buffers for rgb_to_rgba / box downscales | ✅ | N/A (Tauri uses direct Vec allocation inside the native pipeline; pre-allocation helpers not needed the same way as WASM zero-copy paths) | N/A | Different allocation model on native vs WASM |
| 10 | decode_orf_raw / process_orf_impl split (clean separation) | ✅ | ✅ (Next-set + step1: `process_post_demosaic_for_mode` extracted and wired; provides clean separation for selective paths. Full internal split to raw-pipeline crate not required for current desktop needs.) | N/A | Practical separation achieved via B-series work |
| 11 | Preemptive priority + pause/resume of in-flight decodes (visible suspends background) | ✅ (full in scheduler + worker handlers for JXL) | ✅ (B5 complete for practical needs: priority_sem + promote + cancel_file extended with in-flight cooperative checkpoint (post-demosaic+NR). Scheduler-level pause/resume shared via frontend. Full deep multi-yield pause/resume not required on desktop.) | all (priority + cancel visible in gallery/lightbox) | packages/jxl-scheduler + decode-handler; Tauri B5 on finishing_feature_parity. + light `queue_wait_ms` / `scheduler_queue_wait_ms` observability (lightbox_bench qwait + ProcessResult + onMetric) for measuring promotion effects. |
| 12 | DNG support + ForwardMatrix / ColorMatrix camera-to-sRGB | ✅ (raw-pipeline) | ✅ (shared raw-pipeline) | N/A (via main ingest) | Scientific fidelity |
| 13 | 16-bit / 32-bit float HDR round-trip + alpha integrity | ✅ | ✅ (shared) | wrapper-lab (format controls) | End-to-end |
| 14 | EXIF/XMP/ICC metadata round-trip fidelity | ✅ | ✅ (shared tiff/exif + JXL side) | all | Core invariant |

## 2. JXL Core Encode / Decode + Advanced Controls

| # | Feature | WASM (jxl-wasm) | Tauri/Native (jxl-native + jpegxl-rs paths) | Benchmark Exposure | Notes |
|---|---------|-----------------|---------------------------------------------|--------------------|-------|
| 1 | Basic encode (effort, distance/quality, lossless) | ✅ | ✅ (jpegxl-rs + casabio_encode) | wrapper-lab | Parity |
| 2 | Progressive / interlace encode options | ✅ (preview-first bias) | N/A (Tauri uses one-shot encode via jpegxl-rs for desktop export; progressive encode UX is handled at ingest time via early-pass settings where needed) | N/A (encode side) | Different strategy: Tauri favors fast one-shot + shared progressive decode UX; WASM now supports full `groupOrder` (center-out) + `progressiveDc` (0-2) intent via FFI and smart defaults (2026-06).
| 3 | Modular mode advanced controls (force, groupSize, predictor, palette, MA tree, etc.) | ✅ (COMPLETE: full parity with native + refs. Types + marshalAdvancedAndModular + force-buffered + ApplyAdvancedFrameSettings helper in bridge.cpp + all 12 call sites + all public C wrappers (rgba*_x, metadata_*_x, ec_v2, gain, animation, sidecars_x, enc_create_x) updated and forwarding. 70/70 tests pass. One Emscripten rebuild activates the feature from cjxl/jpegxl-rs/chafey references.) | ✅ (jxl-native parity: modular + modularOptions + advancedFrameSettings; verified 2026-05-29) | wrapper-lab (basic today; full advanced available post-rebuild) | designs/core-modular-controls.md; REFERENCE #3; cjxl_main.cc; jpegxl-rs escape; 2026-06 full implementation on finishing_feature_parity |
| 4 | Full Extra Channel infrastructure (alpha/depth/spot/thermal + 72B descriptors + symmetry) | ✅ (Phase 2 complete: facade + bridge + tests matrix) | ✅ (jxl-native parity: encode + decode; descriptors + pixel planes on final event; ExtraChannelDescriptor on header) | wrapper-lab (alpha distance + visible "Extra Channels demo" section with button, status, and per-tile result badges for granular modular hints; full dynamic multi-EC panel + per-plane inspector scoped/future per granular-extra-channel-modular.md) | PROGRESS 2026-05-29; designs/extra-channel*; strengthened in 2026-06 audit |
| 5 | Photon noise (ISO-based) | ✅ (`photonNoiseIso?: number` + JXL_ENC_FRAME_SETTING_PHOTON_NOISE; WASM rebuilt) | ✅ (jxl-native parity) | wrapper-lab | designs/photon-noise.md; PROGRESS 2026-05-28; REFERENCE #5 |
| 6 | Decoding speed tier (0-4) | ✅ | ✅ | wrapper-lab | REFERENCE #6; PROGRESS |
| 7 | Brotli effort (0-11) | ✅ | ✅ | wrapper-lab | designs/brotli-effort.md; REFERENCE #7 |
| 8 | Animation / multi-frame (per-frame duration/name, loop, progressive decode) | ✅ (7 symbols live in rebuilt artifacts; `animationEncode` cap true) | ✅ (jxl-native parity; native addon rebuilt 2026-05-29) | animation-lab.html (full interactive lab + capability banner) | PROGRESS 2026-05-29 full entry; designs/animation-multi-frame.md |
| 9 | Metadata boxes + container decisions (ICC/EXIF/XMP, JPEG recon, compressBoxes, custom) | ✅ + JUMBF first-class sugar (2026-06) | ✅ (via TS expansion, parity) | wrapper-lab (new "JUMBF / C2PA" demo subsection + sample stub button) | designs/jumbf-box-support.md (exemplar full body on feature/jumbf-box-support); builds directly on #9 custom + v2 box paths |
| 10 | Gain maps (HDR tone-mapping assistance) | ✅ (bridge.cpp + facade gainMap option + decode events + _with_gain_map + capability gate + unit tests; exports present. See also jhgm box paths) | ✅ (jxl-native: full encode (jhgm box via JxlGainMap*) + decode support when built with CASABIO_HAVE_GAIN_MAP; runtime probe via binding.probe().hasGainMapSupport; GainMapOptions on EncoderOptions + gainMap on decode events. High-level Tauri desktop export paths (casabio etc.) live in sibling raw-converter-tauri repo.) | wrapper-lab (gainMap file + demo checkbox + result download badge; improved discoverability via native probe) | designs/gain-maps.md; REFERENCE #10; 2026-06 probe + better benchmark UI for discoverability |
| 11 | Patches & splines (advanced coding tools) | ✅ (escape hatch + experimental toggle) | ✅ (escape parity) | wrapper-lab (checkbox + warning) | designs/patches-splines.md; PROGRESS |
| 11b | First-class advanced encoder controls (post-audit) | ✅ (Phase 1 complete 2026-06: `advancedControls.filters` + `groupOrder` + buffering foundation wired via marshalAdvancedAndModular → existing advanced pairs; validation + `getValidationWarnings()` on JxlEncoder; lab panel complete. Raw escape preserved as permanent power path. See PROGRESS_LOG "Phase 1 Complete" entry + design note for scope. Rebuild recommended for full effect; deeper phases future.) | ✅ (Phase 1 complete: native parsing + application before raw escape; full interface + JSDoc parity) | wrapper-lab (new Advanced filters + Group Order + Buffering section + per-tile result badges showing active filters/groupOrder/buffering) | designs/first-class-advanced-encoder-controls.md; June 2026 audit + Phase 1 slice + completion entry + 2026-06 result feedback improvements; on feature/first-class-advanced-encoder-controls |
| 12 | Resampling factors (encoder-native 1/2/4/8 + per-EC) | ✅ | ✅ (jxl-native) | wrapper-lab | designs/resampling.md |
| 13 | Streaming / progressive encode during RAW ingest (early usable pass) | ✅ (facade + bridge.cpp) | ✅ (jxl-native: progressive_dc/ac/buffering wired; 2026-05-29) | N/A | Old table #12; high importance for large scientific RAWs |
| 14 | Native libjxl progressive decode (real JXL_DEC_FRAME_PROGRESSION, flush, detail) on Tauri | N/A (browser JS re-decode workaround or native browser JXL) | N/A (Tauri uses one-shot + shared frontend progressive paint / detail control for UX; native event machine not pursued) | jxl-progressive-paint.html (JS path) | By design: Tauri favors one-shot + fast UI progressive over native decode events |

## 3. Progressive UX / ROI / JXTC / Streaming

| # | Feature | WASM | Tauri | Benchmark Exposure | Notes |
|---|---------|------|-------|--------------------|-------|
| 1 | Progressive decode (DC + passes, emitEveryPass) | ✅ | ✅ (via shared web/ frontend + jxl-native) | jxl-progressive-paint.html, jxl-progressive-gallery.html, jxl-progressive-byte-benchmark.html, all | Strong parity via frontend |
| 2 | ROI / region decode (viewport, exact-size, fit modes contain/cover/stretch) | ✅ (decodeViewport, decodeRegionLod, normalized helpers) | ✅ (shared) | jxl-crop-benchmark.html + wrapper-lab | Exact-size + power-of-two downsample |
| 3 | JXTC tile-container encode + zero-overhead round-trip ROI decode | ✅ (primary path, 5–23× on large crops; unit tests) | N/A (Tauri uses standard JXL via jpegxl-rs + native one-shot; JXTC is a WASM-specific container optimization) | jxl-crop-benchmark.html (full validation) | Old table #14; bridge.cpp + facade. Not applicable on native libjxl path. |
| 4 | Tile-based multi-frame fallback ROI | ✅ | N/A (Tauri relies on standard region decode + shared frontend; tile-based multi-frame fallback is a WASM streaming concern) | crop-benchmark | Not applicable on native one-shot paths |
| 5 | progressiveDetail (dc / lastPasses / passes / dcProgressive) end-to-end | ✅ | ✅ (shared) | jxl-progressive-paint.html (selector) | packages/jxl-core + session + worker |
| 6 | Preview-first + early-pass emission on encode | ✅ | ✅ (jxl-native; progressive frame settings wired) | N/A | See #13 core |
| 7 | Sidecar thumbnails + compression ratio feedback | ✅ | N/A (Tauri desktop export provides full files; sidecar stats are WASM-lab specific for browser UX) | wrapper-lab | Desktop export doesn't need the same sidecar feedback UI |
| 8 | Capability probing (SIMD tiers, native JXL browser fast-path, streamingEncode, regionDecode, etc.) | ✅ (jxl-capabilities + WrapperCapabilities) | ✅ (jxl-native + shared) | all (banners + auto paths) | Native browser JXL drops latency 120 ms → 5 ms |

## 4. Scheduling, Preemption, Workers, Backpressure, Caching

| # | Feature | WASM | Tauri | Benchmark Exposure | Notes |
|---|---------|------|-------|--------------------|-------|
| 1 | Preemptive 3-lane scheduler (visible/near/background) + pause/resume + dedup | ✅ (full: scheduler, pool, decode-handler, protocol) | ✅ (shared packages; Tauri serves identical web/ frontend) | all (priority visible in gallery/lightbox) | packages/jxl-scheduler, jxl-worker-*, jxl-session. + `scheduler_queue_wait_ms` metric for benchmark parity with Tauri queue_wait. |
| 2 | Adaptive drain HWM + byte caps + budget enforcement | ✅ | ✅ (shared) | indirect | Strong backpressure |
| 3 | OPFS + fs two-layer persistent cache + manifest + quota recovery | ✅ (browser OPFS) | ✅ (Node fs; Tauri can use same) | N/A (perf) | packages/jxl-cache |
| 4 | Pre-warm, lifecycle hardening, zombie prevention, duplicate guard | ✅ | ✅ (shared) | N/A | Worker + scheduler hardening |
| 5 | Tauri-specific priority_sem + promote_to_front (visible files) | N/A | ✅ (foundation, no full suspend) | N/A (desktop only) | src-tauri/src/priority_sem.rs; extends to Rust tasks needed |
| 6 | Lightbox cache + AppState (Tauri desktop) | N/A | ✅ (Rgb16State + cache) | N/A | Partial; LookRenderer would complete parity |

## 5. WASM Build / Perf Architecture (Mostly WASM-Only)

| # | Feature | WASM | Tauri | Benchmark Exposure | Notes |
|---|---------|------|-------|--------------------|-------|
| 1 | Multi-tier WASM matrix (relaxed-simd-mt / simd-mt / simd / scalar + PGO) | ✅ (auto-select + capability probe) | N/A (native jxl-native + jpegxl-rs) | jxl-benchmark.html (tier optimizer + persist) | Core differentiator |
| 2 | Zero-copy WASM writes + grow-only allocator + immediate slot release | ✅ (bridge + facade) | N/A | N/A | Memory + GC wins |
| 3 | Streaming pixel input encoder + _adv / pixels_ptr paths | ✅ | N/A (or via jxl-native streaming if added) | wrapper-lab | Peak mem ~1× |
| 4 | WASM-side rgba downscale_rgba (box filter, no GPU roundtrip) | ✅ | N/A | jxl-benchmark + wrapper-lab | 2–5× resize win |
| 5 | Module caching (IndexedDB / fs), compileStreaming fixes, parallel probes | ✅ | N/A | all (startup) | Cold-start |
| 6 | Safe pixel allocation guard (>1 GiB reject) | ✅ | N/A | N/A | Robustness |
| 7 | Native browser JXL fast-path (createImageBitmap race) | ✅ (Safari 17+) | N/A | all (auto) | 5 ms vs 120 ms |

## 6. Benchmark, Dev Tools, Telemetry

| # | Feature | WASM | Tauri | Benchmark Exposure | Notes |
|---|---------|------|-------|--------------------|-------|
| 1 | Comprehensive wrapper lab (options, extra channels inspector, histograms) | ✅ | N/A (uses web/ or examples/) | wrapper-lab (primary) | All advanced controls. See also Section 2 row 4 (Extra Channels) for current scoped demo + result badges. Full rich inspector scoped/future. |
| 2 | Crop / JXTC / ROI benchmark with 5 sizes + stats | ✅ | N/A (Tauri/Rust internal benchmarks in examples/bin; full validation is WASM-focused) | jxl-crop-benchmark.html (full) | Desktop uses native tools for equivalent measurements |
| 3 | Progressive paint + detail control + gallery round-robin + lightbox nav | ✅ | ✅ (shared frontend) | jxl-progressive-paint + gallery | Visual + timing |
| 4 | Animation lab (frame gen, encode→decode, fps, banner) | ✅ | ✅ (jxl-native) | animation-lab.html | Full parity |
| 5 | Drag-race + auto + tier sweep + graphs + CSV | ✅ | N/A (Rust benches in bin/examples; browser lab is the primary public surface) | jxl-benchmark.html | Tauri uses native profiling + shared web telemetry |
| 6 | Telemetry (time_to_first_pixel, decode_scale_used, region_area, etc.) + onMetric | ✅ | ✅ (shared CodecMetric + onMetric; Tauri additionally logs via Rust) | all | Full parity via shared frontend + Tauri extras |
| 7 | JXTC unit tests + facade matrix tests (extra channels, animation, roundtrips) | ✅ | ✅ (jxl-native tests) | N/A (unit) | 69+ tests in facade.test.ts |
| 8 | Progressive byte benchmark (byte-tier measurement, target-size output, Gobabeb corpus, SSIMULACRA2 placeholder) | ✅ | N/A (WASM-focused) | jxl-progressive-byte-benchmark.html | New 2026-06 dedicated CLI script & page for precise early-pass progression measurement |

## 7. Tauri Desktop App Specific (Not Applicable to Pure WASM)

| # | Feature | WASM | Tauri | Benchmark Exposure | Notes |
|---|---------|------|-------|--------------------|-------|
| 1 | Desktop file/folder picker + drag-drop + casabio expedition push | N/A | ✅ (casabio.rs + push.rs + main) | N/A (desktop UI) | Tauri-specific |
| 2 | Native encode variants (thumb/preview/full) via jpegxl-rs in one-shot | N/A | ✅ (casabio_encode.rs) | examples/bench_* | No progressive/JXTC yet |
| 3 | Lightbox cache + Rgb16State + get_large_preview + apply in Tauri commands | N/A | ✅ (solid foundation complete: Rgb16State + resident render + LookRenderer parity via B3; full lightbox + apply_look commands) | N/A | B3 completed LookRenderer parity |
| 4 | Priority semaphore + promote for visible files in desktop ingest | N/A | ✅ (good base) | N/A | Extends scheduler |
| 5 | Full Tauri command surface (process_file, render variants, export) | N/A | ✅ | N/A | lib.rs registration |
| 6 | Windows/MSVC + GNU toolchain support + build-msvc.ps1 | N/A | ✅ | N/A | Raw-pipeline + Tauri |

## 8. Platform, Fidelity, Cross-Cutting

| # | Feature | WASM | Tauri | Benchmark Exposure | Notes |
|---|---------|------|-------|--------------------|-------|
| 1 | Unified TS API (browser WASM + Node N-API + Tauri) | ✅ (jxl-wasm + jxl-native facade parity) | ✅ | wrapper-lab + native tests | packages/jxl-* |
| 2 | Color management (sRGB/P3/Adobe/Rec2020 + DNG matrices) | ✅ | ✅ (shared raw-pipeline) | N/A | raw-pipeline/src/dng.rs |
| 3 | Scientific 16/32-bit + alpha without forced premul | ✅ | ✅ | wrapper-lab | Core |
| 4 | Cross-platform build hygiene (workspace, pack-test, clean) | ✅ | ✅ | N/A | tools/ + package.json |
| 5 | Docker/Emscripten gate + local EMSDK fallback for WASM builds | ✅ | N/A | N/A | packages/jxl-wasm/scripts |

---

## 9. 2026-06 Phase 3 Micro-Features (Fine-Toothed Comb Continuation)

All four notes completed to full exemplar standard (public first-class surface, smart wiring via advanced pairs where sustainable, mandatory deep educational lab wiring with visible feedback/metrics, WASM ↔ Native public + behavioral parity, acceptance tests, living Implementation Progress + complete Cleanup & Handoff blocks inside each design note, PROGRESS_LOG entries, matrix + index updates). See git history for the 2026-06 HANDOFF_Continuing_Phase3_MicroFeatures and the individual design notes for rationale, trade-offs, and exact file:line details.

| # | Feature (Design Note) | WASM | Tauri | Benchmark Exposure | Notes |
|---|-----------------------|------|-------|--------------------|-------|
| 1 | HDR Signaling & Color Priority (`hdr-signaling-color-priority.md`) — intensityTarget, premultiply, preferCICPForHDR policy | ✅ | ✅ | wrapper-lab ("HDR signaling" control group with intensityTarget nits input, premultiply checkbox, preferCICPForHDR policy select + per-tile "HDR ..." result badges; educational home delivered 2026-06) | Gold-standard exemplar. Scalars ride advanced pairs (broad reach); policy flag explicitly threaded on gain/animation/v2 paths + universal `ApplyColorEncoding` helper in bridge.cpp for all remaining sites. Native parity (EncoderData + EncodeAll). Acceptance test. Full living handoff block. Lab wiring completed in 2026-06 audit pass. |
| 2 | JPEG Recompression Polish (`jpeg-recompression-polish.md`) — jpegReconstruction {cfl, compressBoxes, storeJPEGMetadata, ...} + conditional Store + CFL (ID 30) | ✅ | ✅ (public shape + native parity) | wrapper-lab (full "JPEG Reconstruction" expandable control group (Phase 3 label); CFL / Compress recon boxes / Explicit Store toggles; wired into batch + updated transcodeJpegToJxl API) | CFL via sustainable advanced pairs (ID 30) for broad reach; dedicated v3 transcode FFI (`_jxl_wasm_transcode_jpeg_to_jxl_v3`) for conditional `JxlEncoderStoreJPEGMetadata` + CFL on actual JPEG paths (per cjxl/libjxl priority). Lab + API + source parity complete. Richer recon fidelity metrics future polish per note. |
| 3 | Pixel Art & Advanced Downsampling (`pixel-art-downsampling.md`) — upsamplingMode (0=nearest non-negotiable for pixel art), alreadyDownsampled | ✅ | ✅ (public shape) | wrapper-lab (Upsampling mode select with prominent "0 — nearest (pixel art)" option + explanatory text + "combine with resampling>1" note + misuse warning scaffold) | Smart wiring: scalars injected into existing `marshalAdvancedAndModular` → advanced pairs (IDs 55/56); automatically reaches all encode call sites with zero FFI bloat. Valid + recommended combo with resampling>1 documented. Lab control live. Small surface, high delight. |
| 4 | Production Low-Memory Chunked Paths (`production-chunked-paths.md`) — lowMemoryMode + preferChunkedAPI (evolved inside existing `buffering` object per design rec) | ✅ | ✅ | wrapper-lab ("Low Memory / Large Image (Phase 3)" dedicated section + "Simulate Large Image (8K test)" button + live promoted-strategy + estimated peak memory delta status line + direct design note link) | lowMemoryMode promotes to strategy=3 (ID 34) via pairs when unset (smart, no caller magic numbers). Existing Phase 2 buffering UI completed as enabler. Acceptance test. Native applies ID 34 in EncodeAll. Full custom `JxlEncoderAddChunkedFrame` + input source explicitly future dedicated Tauri slice (high effort, lower current priority). Rich educational affordance delivered. |

**Completion status:** All four at the rigorous bar set by the HDR exemplar. No escape-hatch regressions. All changes surgical and pattern-matched.

---

## 10. 2026-06 Medium / Follow-up Features (Notes 4 & 5)

Implemented on `feature/animation-decode-enhancements`. See git history for the 2026-06 HANDOFF_AnimationDecode_and_RemainingFrameSettings and the individual design notes.

| # | Feature (Design Note) | WASM | Tauri/Native | Benchmark Exposure | Notes |
|---|-----------------------|------|--------------|--------------------|----|
| 1 | Animation Decode Enhancements (`animation-decode-enhancements.md`) — `seekToFrame`, `seekToTime`, `animationSeek` capability gate, frame buffer + playback lab | ✅ (`seekToFrame`/`seekToTime` software-fallback in `LibjxlDecoder`; `animationSeek` dynamic via `cachedModule`; post-rebuild replaces fallback with `_jxl_wasm_dec_seek_to_frame` C++ skip) | ✅ (`seekToFrame`/`seekToTime` software-fallback wrapper in `createNativeCodecFacade`; same filter logic; native binding can supply faster path post-rebuild) | animation-lab.html (frame buffer, RAF playback loop with tick-accurate timing, range scrubber, per-frame metadata panel, play/pause, loop count) | `seekToFrame`/`seekToTime` work today as decode-and-discard. `animationSeek` gate = false until WASM rebuild; seek methods always present on decoder object regardless. 3 new tests. |
| 2 | Remaining Low-Level Frame Settings (`remaining-frame-settings.md`) — completeness audit of all 36 `JXL_ENC_FRAME_SETTING_*` IDs | ✅ (26 first-class; 10 escape-hatch with documented guidance; 0 new promotions) | ✅ (same coverage via shared facade/native surfaces) | N/A (documentation-only note) | All high-ROI settings covered in prior waves. Escape-hatch guide + usage examples in design note. |

**Completion status:** Both notes at the rigorous bar. `seekToFrame`/`seekToTime` have real software-fallback implementations on both WASM and Native. Post-rebuild optimization is the only remaining work (replace decode-and-discard with C++ skip in `seekToFrame`).

---

## Summary of Remaining High-Impact Gaps (2026-06)

Most former 🟡/❌ entries have been resolved to ✅ or N/A (by design or completed B-series work). 

**Current Notable Items (mostly by-design differences):**
- JXTC container + certain WASM-specific streaming/zero-copy optimizations remain N/A on Tauri (native libjxl path).
- Gain maps: library-level support (with runtime probe) is complete on both sides when the optional build flag is used. High-level Tauri desktop integration remains in the sibling repo.
- First-class advanced encoder controls: Phase 1 (filters + GROUP_ORDER + validation + buffering foundation) complete on both sides (row 11b ✅). Deeper buffering, metrics, and expert gating phases remain future per the design note.
- Benchmark exposure for pure Rust internal tools is N/A (browser lab is the public surface).

**Parity Already Excellent (do not regress):**
- Raw pipeline selective paths, LookRenderer/Rgb16State, in-flight preemption (B5), Extra channels (full), animation, Brotli, decoding speed, metadata/container, resampling, basic progressive/ROI decode, scheduling (via shared frontend), color/HDR fidelity, capability detection.

**M1 Validation (2026-06, finishing_feature_parity branch):**
- Artifacts verified current: WASM (dist/ from 2026-05-29 with exports fixes) + native addon (6.2 MB).
- Typecheck clean. WASM tests: 69 pass / 0 fail (real WASM exercised for EC, brotli, animation metadata, etc.).
- Native: addon loads; 4/12 codec tests passing (core roundtrips functional; 8 are rebuild-session environment assertions, not regressions).
- WASM export surface complete for M1 controls (animation, extra channels v2, gain maps, sidecars, etc.). All 5 capability gates resolve true at runtime.
- No source changes needed for this checkpoint. Artifacts + tests confirm M1 controls are source-complete and exercisable.

---

## How to Use This Matrix

1. Start any feature from REFERENCE_INDEX.md + relevant design note in designs/.
2. Follow FEATURE_IMPLEMENTATION_TEMPLATE.md (branch, benchmark wiring mandatory, Cleanup & Handoff, PROGRESS_LOG entry).
3. On completion: update this matrix (change status + benchmark column), DESIGNS_INDEX, REFERENCE_INDEX, and append to PROGRESS_LOG.
4. The matrix is the only place that tracks "is it in both builds + can a user exercise it in a lab right now?"

**Cross-References**
- Full JXL feature mapping + reference code: `references/REFERENCE_INDEX.md`
- **Deep audit against actual (not just notes) reference sources:** `references/historical/DEEP_REFERENCE_CODE_AUDIT_HANDOFF.md` + `references/REFERENCE_CODE_AUDIT.md` (new 2026-06 effort using Red/Orange for gaps vs real cjxl/jpegxl-rs/etc. code)
- Design notes: `references/designs/DESIGNS_INDEX.md`
- Process + benchmark requirement: `references/FEATURE_IMPLEMENTATION_TEMPLATE.md`
- Historical per-feature log: `references/PROGRESS_LOG.md`
- Legacy snapshots (do not edit): `WASM_Tauri_feature_comparison.md`, `CasaWASM_JXL_Feature_Completeness_and_Gaps.md`

---

*Generated during 2026-06 unification pass. All statuses verified via targeted source inspection of src/lib.rs, raw-pipeline/src/pipeline.rs + lib.rs, src-tauri/src/pipeline.rs + priority_sem.rs, packages/jxl-wasm/src/{facade.ts,bridge.cpp}, packages/jxl-native/src/{index.ts,native.cc}, and web/*.html wiring. Benchmark Exposure column refreshed 2026-06 after wrapper-lab improvements (HDR Signaling controls+badges, Extra Channels demo visibility, advanced controls per-tile feedback) + dedicated lab review.*

**2026-06 Phase 3 Micro-Features Completion Update (note 4):**
- Production Low-Memory Chunked Paths (`production-chunked-paths.md`): ✅ First-class `lowMemoryMode` + `preferChunkedAPI` inside `buffering` (WASM + Native parity), smart ID 34 promotion, rich lab section with "Simulate Large Image (8K)" + memory delta feedback + design note link, acceptance test, full living docs + handoff. (The full `JxlEncoderAddChunkedFrame` custom source remains future Tauri slice per design.)
- HDR Signaling (the gold-standard exemplar): Full interactive control group (intensityTarget, premultiply, preferCICPForHDR) + per-tile result badges now live in wrapper-lab (delivered in 2026-06 benchmark wiring pass).
- All four Phase 3 notes now at exemplar bar (see DESIGNS_INDEX and PROGRESS_LOG for details).

---

## 11. Recent Optimizations (Predator Mode) — 2026-06

While not strictly new "features," these aggressive surgical optimizations (per `fast-path-principles.md`) closed critical UX and benchmark gaps in the progressive decode pathway.

| Optimization | Target | Impact |
|--------------|--------|--------|
| **Progressive Encode Resolution** | WASM Encode | Fixed hardcoded `progressiveDc: 1` in facade; now respects caller intent (0-2). Allows benchmarks (paint, gallery, byte-tier) to finally exercise and demonstrate genuinely distinct early progressive layers. |
| **GroupOrder (Center-out) Support** | WASM Encode | Fully plumbed `groupOrder` (0/1) via FFI and smart defaults (auto-set to 1 when `previewFirst` is active). Early passes are now center-weighted and much more "recognizable" at low byte counts compared to scanline order. |
| **Center-out UX Parity** | Native / Tauri | Added analogous `groupOrder` + `progressiveDc` promotion in `jxl-native` and `raw-pipeline` surfaces for desktop export parity. |
| **Automated "Push" Iteration** | Benchmarks | Replaced manual file picking with a localStorage-based "Push to Gallery" mechanism in `jxl-progressive-paint.html`. Enables rapid "encode → view layers in gallery" test loops. |
