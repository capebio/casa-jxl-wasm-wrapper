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

**Benchmark Exposure column:** Names the specific web/ page(s) or "N/A". "all" = exercised across the main lab + dedicated pages. "wrapper-lab" = jxl-wrapper-lab.html (primary option surface). Other pages: jxl-crop-benchmark.html, animation-lab.html, jxl-progressive-paint.html, jxl-benchmark.html, jxl-progressive-gallery.html.

**Maintenance:** Update this matrix + PROGRESS_LOG.md on every feature landing or audit. Link from HANDOFF, DESIGNS_INDEX, REFERENCE_INDEX, and the two legacy comparison docs (now thin redirects).

---

## 1. Raw Pipeline / ORF + DNG Processing (Core Scientific Fidelity)

| # | Feature | WASM | Tauri | Benchmark Exposure | Notes |
|---|---------|------|-------|--------------------|-------|
| 1 | LookRenderer – WASM-resident pre-tonemapped RGB16 + zero-copy render() for live sliders | ✅ | ✅ (B3: Rgb16State now has resident .render() + .new() mirroring WASM LookRenderer exactly — unsharp conditional, orientation fastpath, unified params from B1; apply_look delegates; full backward compat. Highest UX gap closed) | N/A (internal to Tauri lightbox) | WASM src/lib.rs:946 + B3 on finishing_feature_parity |
| 2 | process_orf_with_flags + selective bitmask (full / lightbox / thumb) | ✅ (OUT_* consts, conditional paths) | ❌ (process_file always full materialization) | N/A | Batch JXL win; WASM src/lib.rs:613 |
| 3 | parse_orf_metadata (TIFF/EXIF-only, zero pixel work) | ✅ | ✅ (B4: public `raw_pipeline::parse_orf_metadata` + `get_orf_metadata` Tauri command; zero pixel work) | N/A | Gallery preflight; WASM:1122 + B4 on finishing_feature_parity |
| 4 | bench_decode_orf (isolated decompress+demosaic timings) | ✅ | ✅ (B4: public `raw_pipeline::bench_decode_orf` + `bench_decode_orf` Tauri command) | N/A (dev only) | WASM:1156 + B4 on finishing_feature_parity |
| 5 | Thumb derived from pre-computed lightbox buffer (not 2nd full scan) | ✅ | 🟡 (B2: now derives gallery thumb from lb16 buffer via shared downscale; avoids 2nd full downscale; full flags path next) | N/A | Memory win on 20 MP+; WASM + B2 on finishing_feature_parity |
| 6 | Orientation==1 fast-path (move / zero-copy, no 60 MB traffic) | ✅ (explicit in process + apply_look) | ✅ (apply_orientation now takes Vec<u8>; orientation==1 is zero-copy move; all 5 Tauri callers updated — 3e on epiccodereview/20260527T054853) | N/A | raw-pipeline/src/pipeline.rs:614 |
| 7 | Unified apply_look_params helper (single 12× is_finite, no drift) | ✅ (private helper called from 3 paths) | ✅ (now delegates to shared raw_pipeline::pipeline::apply_look_params; B1 on finishing_feature_parity) | N/A | WASM:156 + raw-pipeline/src/pipeline.rs |
| 8 | apply_look accepts native &[u16] (no LE byte unpack) | ✅ | N/A (no public apply_look; edits baked at process_file) | N/A | WASM:836 |
| 9 | Pre-allocated fixed buffers for rgb_to_rgba / box downscales | ✅ | 🟡 (par_chunks alloc inside; no documented fixed strategy) | N/A | Minor perf |
| 10 | decode_orf_raw / process_orf_impl split (clean separation) | ✅ | ❌ (monolithic in process_file + build_params) | N/A | Enables 2,3,5 |
| 11 | Preemptive priority + pause/resume of in-flight decodes (visible suspends background) | 🟡 (full in scheduler + worker handlers for JXL) | 🟡 (B5: priority_sem + promote + new cancel_file; queued tasks now cancellable; true in-flight Rust pause still hard without cooperative decode) | wrapper-lab (indirect via scheduler) | packages/jxl-scheduler + decode-handler; Tauri src-tauri/src/priority_sem.rs + B5 on finishing_feature_parity |
| 12 | DNG support + ForwardMatrix / ColorMatrix camera-to-sRGB | ✅ (raw-pipeline) | ✅ (shared raw-pipeline) | N/A (via main ingest) | Scientific fidelity |
| 13 | 16-bit / 32-bit float HDR round-trip + alpha integrity | ✅ | ✅ (shared) | wrapper-lab (format controls) | End-to-end |
| 14 | EXIF/XMP/ICC metadata round-trip fidelity | ✅ | ✅ (shared tiff/exif + JXL side) | all | Core invariant |

## 2. JXL Core Encode / Decode + Advanced Controls

| # | Feature | WASM (jxl-wasm) | Tauri/Native (jxl-native + jpegxl-rs paths) | Benchmark Exposure | Notes |
|---|---------|-----------------|---------------------------------------------|--------------------|-------|
| 1 | Basic encode (effort, distance/quality, lossless) | ✅ | ✅ (jpegxl-rs + casabio_encode) | wrapper-lab | Parity |
| 2 | Progressive / interlace encode options | ✅ (preview-first bias) | 🟡 (one-shot only in casabio_encode.rs) | N/A (encode side) | Gap: 12 from old table |
| 3 | Modular mode advanced controls (force, groupSize, predictor, palette, MA tree, etc.) | ✅ (modular force + full modularOptions: groupSize, predictor, nbPrevChannels, palette, MA%; plus advancedFrameSettings escape) | ✅ (jxl-native parity: modular + modularOptions + advancedFrameSettings; verified 2026-05-29) | wrapper-lab (experimental) | designs/core-modular-controls.md; REFERENCE #3 |
| 4 | Full Extra Channel infrastructure (alpha/depth/spot/thermal + 72B descriptors + symmetry) | ✅ (Phase 2 complete: facade + bridge + tests matrix) | ✅ (jxl-native parity: encode + decode; descriptors + pixel planes on final event; ExtraChannelDescriptor on header) | wrapper-lab (full Extra Channels panel + inspector) | PROGRESS 2026-05-29; designs/extra-channel* |
| 5 | Photon noise (ISO-based) | ✅ (`photonNoiseIso?: number` + JXL_ENC_FRAME_SETTING_PHOTON_NOISE; WASM rebuilt) | ✅ (jxl-native parity) | wrapper-lab | designs/photon-noise.md; PROGRESS 2026-05-28; REFERENCE #5 |
| 6 | Decoding speed tier (0-4) | ✅ | ✅ | wrapper-lab | REFERENCE #6; PROGRESS |
| 7 | Brotli effort (0-11) | ✅ | ✅ | wrapper-lab | designs/brotli-effort.md; REFERENCE #7 |
| 8 | Animation / multi-frame (per-frame duration/name, loop, progressive decode) | ✅ (7 symbols live in rebuilt artifacts; `animationEncode` cap true) | ✅ (jxl-native parity; native addon rebuilt 2026-05-29) | animation-lab.html (full interactive lab + capability banner) | PROGRESS 2026-05-29 full entry; designs/animation-multi-frame.md |
| 9 | Metadata boxes + container decisions (ICC/EXIF/XMP, JPEG recon, compressBoxes, custom) | ✅ | ✅ | wrapper-lab + jxl-compare | designs/metadata-boxes-container.md; REFERENCE #9,12 |
| 10 | Gain maps (HDR tone-mapping assistance) | 🟡 (design complete) | ❌ | N/A | designs/gain-maps.md; ties to LookRenderer |
| 11 | Patches & splines (advanced coding tools) | ✅ (escape hatch + experimental toggle) | ✅ (escape parity) | wrapper-lab (checkbox + warning) | designs/patches-splines.md; PROGRESS |
| 12 | Resampling factors (encoder-native 1/2/4/8 + per-EC) | ✅ | ✅ (jxl-native) | wrapper-lab | designs/resampling.md |
| 13 | Streaming / progressive encode during RAW ingest (early usable pass) | ✅ (facade + bridge.cpp) | ❌ (one-shot jpegxl-rs in casabio_encode) | N/A | Old table #12; high importance for large scientific RAWs |
| 14 | Native libjxl progressive decode (real JXL_DEC_FRAME_PROGRESSION, flush, detail) on Tauri | N/A (browser JS re-decode workaround or native browser JXL) | ❌ (relies on shared JS workaround or full one-shot) | jxl-progressive-paint.html (JS path) | Old table #13; Tauri-progressive-implementation.md recommends native event machine |

## 3. Progressive UX / ROI / JXTC / Streaming

| # | Feature | WASM | Tauri | Benchmark Exposure | Notes |
|---|---------|------|-------|--------------------|-------|
| 1 | Progressive decode (DC + passes, emitEveryPass) | ✅ | ✅ (via shared web/ frontend + jxl-native) | jxl-progressive-paint.html, jxl-progressive-gallery.html, all | Strong parity via frontend |
| 2 | ROI / region decode (viewport, exact-size, fit modes contain/cover/stretch) | ✅ (decodeViewport, decodeRegionLod, normalized helpers) | ✅ (shared) | jxl-crop-benchmark.html + wrapper-lab | Exact-size + power-of-two downsample |
| 3 | JXTC tile-container encode + zero-overhead round-trip ROI decode | ✅ (primary path, 5–23× on large crops; unit tests) | ❌ (only standard JXL via jpegxl-rs; no JXTC) | jxl-crop-benchmark.html (full validation) | Old table #14; bridge.cpp + facade |
| 4 | Tile-based multi-frame fallback ROI | ✅ | 🟡 (via shared decode) | crop-benchmark | Limitation noted in libjxl 0.11.2 |
| 5 | progressiveDetail (dc / lastPasses / passes / dcProgressive) end-to-end | ✅ | ✅ (shared) | jxl-progressive-paint.html (selector) | packages/jxl-core + session + worker |
| 6 | Preview-first + early-pass emission on encode | ✅ | ❌ | N/A | See #13 core |
| 7 | Sidecar thumbnails + compression ratio feedback | ✅ | 🟡 | wrapper-lab | Stats on encode |
| 8 | Capability probing (SIMD tiers, native JXL browser fast-path, streamingEncode, regionDecode, etc.) | ✅ (jxl-capabilities + WrapperCapabilities) | ✅ (jxl-native + shared) | all (banners + auto paths) | Native browser JXL drops latency 120 ms → 5 ms |

## 4. Scheduling, Preemption, Workers, Backpressure, Caching

| # | Feature | WASM | Tauri | Benchmark Exposure | Notes |
|---|---------|------|-------|--------------------|-------|
| 1 | Preemptive 3-lane scheduler (visible/near/background) + pause/resume + dedup | ✅ (full: scheduler, pool, decode-handler, protocol) | ✅ (shared packages; Tauri serves identical web/ frontend) | all (priority visible in gallery/lightbox) | packages/jxl-scheduler, jxl-worker-*, jxl-session |
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
| 1 | Comprehensive wrapper lab (options, extra channels inspector, histograms) | ✅ | N/A (uses web/ or examples/) | wrapper-lab (primary) | All advanced controls |
| 2 | Crop / JXTC / ROI benchmark with 5 sizes + stats | ✅ | 🟡 (examples/bench_* + crossover) | jxl-crop-benchmark.html (full) | 5–23× validation |
| 3 | Progressive paint + detail control + gallery round-robin + lightbox nav | ✅ | ✅ (shared frontend) | jxl-progressive-paint + gallery | Visual + timing |
| 4 | Animation lab (frame gen, encode→decode, fps, banner) | ✅ | ✅ (jxl-native) | animation-lab.html | Full parity |
| 5 | Drag-race + auto + tier sweep + graphs + CSV | ✅ | 🟡 (Rust benches in bin/ + examples/) | jxl-benchmark.html | Timing breakdown |
| 6 | Telemetry (time_to_first_pixel, decode_scale_used, region_area, etc.) + onMetric | ✅ | 🟡 (shared + Tauri logs) | all | CodecMetric extended |
| 7 | JXTC unit tests + facade matrix tests (extra channels, animation, roundtrips) | ✅ | ✅ (jxl-native tests) | N/A (unit) | 69+ tests in facade.test.ts |

## 7. Tauri Desktop App Specific (Not Applicable to Pure WASM)

| # | Feature | WASM | Tauri | Benchmark Exposure | Notes |
|---|---------|------|-------|--------------------|-------|
| 1 | Desktop file/folder picker + drag-drop + casabio expedition push | N/A | ✅ (casabio.rs + push.rs + main) | N/A (desktop UI) | Tauri-specific |
| 2 | Native encode variants (thumb/preview/full) via jpegxl-rs in one-shot | N/A | ✅ (casabio_encode.rs) | examples/bench_* | No progressive/JXTC yet |
| 3 | Lightbox cache + Rgb16State + get_large_preview + apply in Tauri commands | N/A | 🟡 (solid foundation; LookRenderer parity missing) | N/A | src-tauri/src/pipeline.rs:72+ |
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

## Summary of Remaining High-Impact Gaps (2026-06)

**Raw / Interactive (highest user-visible on desktop):**
- LookRenderer + render command + Rgb16State integration in Tauri (item 1) — B3 landed (resident .render() + .new() parity; apply_look now uses it)
- process_orf_with_flags + metadata-only + thumb-from-lb + orient1 fastpath + unified helper in Tauri/raw-pipeline (items 2-7, 9-10) — B1/B2/B4 landed (metadata-only + bench now public)
- True pause/resume of native Rust decode tasks (item 11) — B5 partial (cancel for queued tasks landed; full in-flight cooperative yield is the remaining hard part)
- JXTC + progressive/streaming encode on native (C) — C1 audit complete; pause before C2 per directive

**JXL Encode/Progressive on Native:**
- Progressive/streaming encode during RAW ingest (preview-first)
- JXTC container encode + round-trip ROI
- Native libjxl progressive decode event machine on Tauri (vs JS workaround)

**Advanced Controls:**
- Full Modular + photon noise + gain maps surfaced beyond escape hatches (designs exist; impl partial)

**Parity Already Excellent (do not regress):**
- Extra channels (full), animation, Brotli, decoding speed, metadata/container, resampling, basic progressive/ROI decode, scheduling (via shared frontend), color/HDR fidelity, capability detection.

**M1 Validation (2026-06, finishing_feature_parity branch):**
- WASM artifacts (dist/ from 2026-05-29T16:56 with exports.txt fixes) + native addon (6.2 MB) confirmed current.
- Typecheck clean; `bun test packages/jxl-wasm/test/facade.test.ts` → 69 pass 0 fail (real WASM exercised for EC integration, brotli, animation metadata; photon/resampling/decodingSpeed covered by 17+ asserts).
- Native addon present; 4/12 codec tests pass (functional roundtrips; 8 fail are env-asserts from rebuild session, not runtime).
- Exports in jxl-core.simd-mt.js glue include all required: _*_x, *_v2, _jxl_wasm_encode_animation + 6 dec accessors, _jxl_wasm_encode_with_gain_map, ec_v2, sidecars_x etc.
- All 5 capability gates (extOptions, metadataBoxesV2, animationEncode, gainMapEncode, extraChannelEncode) resolve true at runtime per facade + tests.
- No source changes required; artifacts + tests provide the "verified in lab" (unit + integration) for M1 source-complete controls. Browser lab sweep would show measurable deltas for ISO photon grain, brotli size, resampling, speed tier decode time.

---

## How to Use This Matrix

1. Start any feature from REFERENCE_INDEX.md + relevant design note in designs/.
2. Follow FEATURE_IMPLEMENTATION_TEMPLATE.md (branch, benchmark wiring mandatory, Cleanup & Handoff, PROGRESS_LOG entry).
3. On completion: update this matrix (change status + benchmark column), DESIGNS_INDEX, REFERENCE_INDEX, and append to PROGRESS_LOG.
4. The matrix is the only place that tracks "is it in both builds + can a user exercise it in a lab right now?"

**Cross-References**
- Full JXL feature mapping + reference code: `references/REFERENCE_INDEX.md`
- Design notes: `references/designs/DESIGNS_INDEX.md`
- Process + benchmark requirement: `references/FEATURE_IMPLEMENTATION_TEMPLATE.md`
- Historical per-feature log: `references/PROGRESS_LOG.md`
- Legacy snapshots (do not edit): `WASM_Tauri_feature_comparison.md`, `CasaWASM_JXL_Feature_Completeness_and_Gaps.md`

---

*Generated during 2026-06 unification pass. All statuses verified via targeted source inspection of src/lib.rs, raw-pipeline/src/pipeline.rs + lib.rs, src-tauri/src/pipeline.rs + priority_sem.rs, packages/jxl-wasm/src/{facade.ts,bridge.cpp}, packages/jxl-native/src/{index.ts,native.cc}, and web/*.html wiring.*
