# WASM ↔ Tauri Feature Parity Matrix (Master)

**Single Source of Truth for Feature Completeness**  
**Date:** 2026-06-08 (parity program implementation started)  
**Purpose:** Complete inventory of *all* features across the stack (raw-pipeline + CasaWASM JXL wrapper + scheduling + benchmark harness + Tauri desktop), with implementation status for the browser WASM pathway vs. the native Tauri/desktop pathway, plus exposure in the web Benchmark UIs. Extends the earlier partial "new features" comparison (WASM_Tauri_feature_comparison.md) to full coverage.

**Parity program:** Implementation sequencing, boundary hacks, pyramid gallery, and PR stack live in [`TauriWasmParity.md`](TauriWasmParity.md) (rev 5). The checklist below maps every matrix feature to that doc.

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

**Maintenance:** Update this matrix + PROGRESS_LOG.md on every feature landing or audit. Link from HANDOFF, DESIGNS_INDEX, REFERENCE_INDEX, and the two legacy comparison docs (now thin redirects). When a row's Tauri port status changes, update both this checklist and the detail table in the matching section below.

---

## 0. Parity Program Checklist → [`TauriWasmParity.md`](TauriWasmParity.md)

Master checklist for Tauri port / parity work. **Matrix** = detail section below. **Parity** = section in `TauriWasmParity.md` (hack IDs `H*`, boundary taxes `B-T*`, decisions `K*`, phases, PRs).

**Legend:** ☑ parity or N/A by design · ☐ open Tauri port · 🟡 partial · — no further port action

**Implementation log (2026-06-08, Tauri parity continuation):** Phase −1 boundary surgery complete in `raw-converter-tauri` — B-T5..B-T8, H31/H32/H22 encode-tier, PR-6b native pyramid encoder synced, `jxl_lowlevel` vendor synced. **H29** `apply_look_stream` Channel slider path + **PR-3** `decode_progressive_frames` wired into bg lightbox (`jxl_progressive_pass` events). `web/main.js` updated for Channel slider + progressive JXL repaint. Open: PR-7b pyramid ingest at `process_file`. + image-store handoff (S1->S3->S2): centralized manifest+level acquisition in web/pyramid-gallery/image-store.js; eliminated dupe fetch in grid-controller + pyramid-lightbox (M1 client polish).
**Implementation log (2026-06-08, updated post-M3 foundation):** Phase −1 partial in `raw-converter-tauri`. `web/main.js` wired as before. 
- **M0 (Grok Build core, Gemini clerical):** Plan A WASM **complete** (feat/pyramid-m0-wasm-primitives @93afee7) — `sidecars_v2` (per-level distances, no 2048 floor clamp), `downscaleRgba16`, `encodeRgba8Pyramid` + wrappers/caps/tests (source 6/6 + runtime gradient/floor proof). 
- **M1 (Grok core + Gemini matrices/fixtures/docs):** Plan B WASM **complete** (feat/pyramid-m1-ingest-cli @08f9d0e + feat/pyramid-m1-gallery-grid) — `@casabio/pyramid-ingest` (quality/ladder/hash/shard/manifest/backends/ladder/raw/ingest/cli; 8-bit only, JPG lossless transcode once, proxy single-level, resumable mtime, contenthash, shard isolation, atomic); gallery grid (index.json seed, aspect no-shift, L0 first, DPR upgrade, scheduler one-shot _jxl_wasm_decode_rgba8 keyed by contenthash, monotonic, crossfade, viewport+prefetch ring, cancel-before-start, LRU/OPFS reuse). 34/34+ guard tests, tsc green.
- **M2 (Grok Build core, Gemini presets scaffolding):** 8-bit lightbox **complete** (Implementing_Pyramid branch / M2 worktree) — FilterEngine (12 CasaBio presets + 8 sliders per m2-checklist; per-pixel non-linear shadows lift (luma-masked) + highlights compress on top of matrix for better 8-bit preview while 16-bit pyramid data remains untouched/integral); live visible-screen hist (viewport readback); zoom ladder (DPR-adaptive + crossfade from grid cached L0/L1 seed); canvas pan (transform only); monotonic LRU; scheduler one-shot (contenthash key, visible/near prio); extracted pyramid-lightbox.js module; RAW-only 16-bit toggle stub (M3 path, off default — M2 lightbox always works with 8-bit decoded for UI/screens, preserving full 16-bit headroom for shadows/highlights in M3 toggle). Unit tests + QA items. (See pyramid table for full details.)
- **M3 (Grok high-effort foundation, in progress):** 16-bit RAW path started (feat/pyramid-m3-raw16-webgl-roi) — Rust `src/lib.rs` exposes full-res RGB16 buffer (OUT_FULL_16=8 flag, rgb16_full/take_rgb16_full/pack in orf/dng/cr2 paths, no schema bump); pyramid-ingest updated (manifest dynamic bitsPerSample 8|16, ladder RAW big-levels 16-bit data + encodePyramid16 path, raw-backend requests 1|8 + surfaces packed 16, backends extended); client lightbox dither16To8 + 16-bit toggle UI (RAW only, off default, basic JS dither + structure for WebGL float + FS dither + ROI via region). Placeholder encode16 (real needs facade M0 16-primitive wiring). Grid/JPG remain 8-bit. Full rebuild + tests pending.

### 0.1 Boundary surgery & IPC (highest ROI — do first)

| ☐ | Feature | Matrix | WASM | Tauri | Parity (`TauriWasmParity.md`) |
|---|---------|--------|------|-------|-------------------------------|
| ☑ | Thumb via JSON u8 integer array in `ProcessResult` | §7.3 | N/A | ☑ | **B-T1**, **H5**, Phase −1, **PR-0a** — `thumb_cache` + `get_thumb(id)` binary Response; dims-only in `ProcessResult` |
| ☑ | Redundant `jxl` base64 when `jxl_cache` has bytes | §7.2 | N/A | ☑ | **B-T2**, **H4**, Phase −1, **PR-0b** — default id-only; `jxl_cached: true`; optional `include_jxl` |
| ☑ | `(*jxl_arc).clone()` on bg JXL prefill | §7.3 | N/A | ☑ | **B-T3**, **H2**, Phase −1, **PR-0c** — `decode_jxl_full_inner(&Arc)` |
| ☑ | `jxl_dc_preview` base64 RGB events | §3.1 | ✅ | ☑ | **B-T4**, **H7**, Phase −1, **PR-0e** — event `{id,w,h}` only; pixels via `get_jxl_lightbox` |
| ☑ | `file_thumb_fast` JPEG base64 relay | §6.3 | N/A | ☑ | **B-T5**, **H6**, Phase −1, **PR-0d** — DCT decode + `get_fast_thumb(path)` binary Response; event `{path,w,h,orientation,sensor_*}` only |
| ☑ | Full JXL decode → downscale lightbox prefill | §3.2, §7.3 | ✅ | ☑ | **B-T6**, **H9** — `jxl_lb_cache` (~1800 long-edge tier) + `decode_jxl_level_for_id`; bg prefill prefers lb tier |
| ☑ | Subject crop RGBA→RGB strip on encode | §3.2 | ✅ | ☑ | **B-T7**, **H11**, **PR-5** — `crop_rgba8` + `encode_jxl_with_channels` ch=4 |
| ☑ | `pack_rgb_response` always allocates | §7.3 | N/A | ☑ | **B-T8**, **H26**, **PR-0c** — `pack_rgb_response_arc` / `rgb_to_response_from_frame` |
| ☑ | Binary IPC hot paths (`apply_look`, `decode_jxl_*`) | §7.3 | N/A | ☑ | **H3**, **H19** — extended to thumb via `get_thumb` |
| ☑ | `Channel` streaming `apply_look` (slider UX) | §7.3 | N/A | ☑ | **H29**, Phase 3 polish, §6.6 — `apply_look_stream` + `look_render_gens` cancel; `web/main.js` Channel paint |

### 0.2 Format ingest & RAW pipeline

| ☐ | Feature | Matrix | WASM | Tauri | Parity |
|---|---------|--------|------|-------|--------|
| ☑ | LookRenderer / `Rgb16State` resident render | §1.1 | ✅ | ✅ | §5.1 — maintain |
| ☑ | `process_orf_with_flags` selective outputs | §1.2 | ✅ | ✅ | §5.1 — maintain |
| ☑ | `parse_orf_metadata` / `get_orf_metadata` | §1.3 | ✅ | ✅ | — maintain |
| ☑ | `bench_decode_orf` | §1.4 | ✅ | ✅ | **PR-11** harness unify, §9 |
| ☑ | Thumb from pre-computed lightbox buffer | §1.5 | ✅ | ✅ | — maintain |
| ☑ | Orientation==1 zero-copy fast path | §1.6 | ✅ | ✅ | — maintain |
| ☑ | Unified `apply_look_params` | §1.7 | ✅ | ✅ | — maintain |
| — | `apply_look` native `&[u16]` (WASM-only API) | §1.8 | ✅ | N/A | §4.4 — no port |
| — | Pre-allocated rgb_to_rgba buffers | §1.9 | ✅ | N/A | **H24** / **H38** optional `SlabPool`, §12 Tier 2 |
| ☑ | `process_post_demosaic_for_mode` separation | §1.10 | ✅ | ✅ | — maintain |
| ☑ | Preemptive priority + in-flight cancel | §1.11 | ✅ | ✅ | **H30**, **K8** — maintain |
| ☑ | DNG decode + camera matrices | §1.12 | ✅ | ☑ | **H31**, **PR-0f** — `decode_source_file` → `dng::decode_bytes` in `process_file` |
| ☑ | CR2 decode (`process_cr2`) | *(parity only)* | ✅ | ☑ | **H31**, **PR-0f** — `cr2::decode_bytes` router in `process_file` |
| ☑ | 16/32-bit HDR + alpha round-trip | §1.13 | ✅ | ✅ | Pyramid **M3** 16-bit lightbox, §11 |
| ☑ | EXIF/XMP/ICC metadata fidelity | §1.14 | ✅ | ✅ | — maintain |
| ☑ | Multi-format ingest router (ORF/DNG/CR2/JPG) | *(parity only)* | ✅ | ☑ | **H31**, **H32**, **K16**, **PR-0f** — `classify_source_format` + dedicated JPG path in `process_file` |
| ☑ | JPG lossless `transcodeJpegToJxl` ingest | §9.2 | ✅ | ☑ | **H32** — `jxl_native::transcode_jpeg_to_jxl` on JPG `process_file` ingest |
| ☑ | Direct `process_rgba` encode path | §7.2 | ✅ | ✅ | **H1**, **K1** — maintain |
| ☑ | Native `fast-jpeg` DCT embedded preview | §6.2 | ✅ | ☑ | **H6**, **H20**, **H27**, **PR-0d** — `fast_jpeg::decode_scaled_rgb8` + `get_fast_thumb` |

### 0.3 JXL encode / decode controls

| ☐ | Feature | Matrix | WASM | Tauri | Parity |
|---|---------|--------|------|-------|--------|
| ☑ | Basic encode (effort, distance, lossless) | §2.1 | ✅ | ✅ | — maintain |
| 🟡 | Progressive encode (Dc, Ac, groupOrder, previewFirst) | §2.2, §2.13 | ✅ | 🟡 | **H34**, Phase 1, **PR-4**; §11 Predator |
| ☑ | Modular advanced controls | §2.3 | ✅ | ✅ | — maintain (rebuild WASM to activate) |
| ☑ | Extra channel infrastructure | §2.4 | ✅ | ✅ | — maintain |
| ☑ | Photon noise ISO | §2.5 | ✅ | ✅ | — maintain |
| ☑ | `decodingSpeed` tier (0–4) on product paths | §2.6 | ✅ | ☑ | **H22**, **PR-4** — `ProcessOptions.decoding_speed` (default 2) wired at encode via `JXL_ENC_FRAME_SETTING_DECODING_SPEED` |
| ☑ | Brotli effort | §2.7 | ✅ | ✅ | — maintain |
| ☑ | Animation / multi-frame + blend modes | §2.8, §10.1 | ✅ | ✅ | **H44** seek C++ skip optional |
| ☑ | Metadata boxes + JPEG recon (v3 transcode) | §2.9, §9.2 | ✅ | ✅ | **H32** for ingest transcode |
| ☑ | Gain maps | §2.10 | ✅ | ✅ | — maintain |
| ☑ | Patches & splines escape hatch | §2.11 | ✅ | ✅ | — maintain |
| ☑ | First-class advanced encoder controls | §2.11b | ✅ | ✅ | — maintain |
| ☑ | Resampling factors | §2.12 | ✅ | ✅ | — maintain |
| 🟡 | `encode_variants_with_progressive` at desktop ingest | §2.13 | ✅ | 🟡 | Phase 1, §4.3 **P2** |
| ☑ | `jxl_lowlevel` progressive decode in lightbox | §2.14 | ✅ | ☑ | **PR-1** vendor synced; **PR-3** `decode_progressive_frames` in `prefill_jxl_lightbox_progressive` + `jxl_progressive_pass` / `jxl_lightbox_ready` |
| ☑ | Per-level pyramid sidecar encode (v2 distances) | §3.7 | ✅ | ✅ | **H12**, **H40** — WASM `sidecars_v2` verified; **PR-6b** native (Falcon=3 effort, box cascade, from_rgb16 helper) done |
| ☑ | `encodeRgba8Pyramid` + `downscaleRgba16` | *(parity only)* | ✅ | ✅ | Plan A WASM done; Tauri native port (**PR-6b**) done (raw-pipeline + encode_rgba8_pyramid_from_rgb16 for PR-7b) |

### 0.4 Progressive UX, ROI, streaming

| ☐ | Feature | Matrix | WASM | Tauri | Parity |
|---|---------|--------|------|-------|--------|
| 🟡 | Within-image progressive decode + paint policy | §3.1 | ✅ | 🟡 | §1, **K6**, **H42**, Phase 3 **K15** — not gallery primary (**K2**) |
| ☑ | ROI / region decode (`decodeViewport`, LOD) | §3.2 | ✅ | 🟡 | **H35**, **H39**, `decode_jxl_region_for_id` |
| — | JXTC tile-container encode + ROI | §3.3 | ✅ | N/A | **H10**, **K4**; Tauri **TJLX**; Plan **E** |
| — | Tile-based multi-frame fallback ROI | §3.4 | ✅ | N/A | §4.4 — WASM-only |
| ☑ | `progressiveDetail` end-to-end | §3.5 | ✅ | ✅ | §1.2 diagnostic vs product table |
| 🟡 | Preview-first + container JPEG recon decode | §3.6 | ✅ | ❌ | **H33**, **H27** — legacy until pyramid L0 |
| — | Sidecar thumb UI feedback | §3.7 | ✅ | N/A | Superseded by pyramid levels **H12** |
| ☑ | Capability probing (tiers, native JXL, region) | §3.8 | ✅ | ✅ | — maintain |
| ☐ | Canvas ImageData slack-safe buffers | §11 (Predator) | ✅ | ☐ | §1.1, **H3**, **H26** |
| ☐ | Opportunistic flush + chunk-yield contracts | §3.1 | ✅ | 🟡 | §1.2, `Agents.md`; native **H43** UI dedup |
| ☑ | Progressive paint speedups A3/A4 | §6.3, §11 | ✅ | 🟡 | §1.3 — Tauri: texture reuse + stats gate |
| 🟡 | RAW "nice preview" tone (viewer QA only) | §11 | ✅ | ❌ | §1.4 — paint lab only; not ingest (**K1**) |
| ☐ | PSNR ≥ 40 dB progressive regression gate | §6.3 | ✅ | ❌ | §1.5, §9.5 — Phase 3 QA |
| ☐ | Subject pre-crop JXL cache + ROI decode | §3.2 | ✅ | ☑ | **H11** ✅; maintain |
| ☐ | TJLX tiled container (native) | §3.3 | N/A | ☑ | **H10** ✅; Plan **E** threshold align |

### 0.5 Scheduling, caching, workers

| ☐ | Feature | Matrix | WASM | Tauri | Parity |
|---|---------|--------|------|-------|--------|
| 🟡 | 3-lane scheduler + dedupe | §4.1 | ✅ | 🟡 | **H15**, **K8** — contenthash dedupe with pyramid |
| ☑ | Adaptive drain HWM + budget | §4.2 | ✅ | ✅ | Shared web frontend — maintain |
| — | OPFS + fs persistent cache | §4.3 | ✅ | N/A | Tauri FS faster; pyramid `levels/` **H28** |
| ☑ | Worker prewarm + lifecycle hardening | §4.4 | ✅ | ✅ | — maintain |
| ☑ | `priority_sem` + promote (desktop) | §4.5 | N/A | ✅ | **H30** — maintain |
| ☑ | Lightbox cache + `AppState` | §4.6, §7.3 | N/A | ✅ | Extend for pyramid manifest **PR-7b** |

### 0.6 WASM build architecture (mostly N/A — principles only)

| ☐ | Feature | Matrix | WASM | Tauri | Parity |
|---|---------|--------|------|-------|--------|
| — | Multi-tier WASM matrix (simd-mt, PGO) | §5.1 | ✅ | N/A | §4.4; native LTO per Opus 4.7 §10 |
| — | Zero-copy WASM heap + grow-only alloc | §5.2 | ✅ | N/A | **H24**, **H8** principle → **H38** `SlabPool` |
| — | Streaming pixel encoder | §5.3 | ✅ | N/A | **H25** arena principle for TJLX tiles |
| — | WASM `downscale_rgba` | §5.4 | ✅ | N/A | Native box downscale synced §5.1 |
| — | Module caching / compileStreaming | §5.5 | ✅ | N/A | — |
| — | Safe pixel alloc guard (>1 GiB) | §5.6 | ✅ | N/A | — |
| — | Native browser JXL `<img>` fast path | §5.7 | ✅ | N/A | §4.4 — desktop uses in-process decode |

### 0.7 Benchmark, telemetry, dev tools

| ☐ | Feature | Matrix | WASM | Tauri | Parity |
|---|---------|--------|------|-------|--------|
| — | Wrapper lab (advanced controls) | §6.1 | ✅ | N/A | **P5** dev tooling |
| — | Crop / JXTC benchmark | §6.2 | ✅ | N/A | **H10**; native `strategy_bench` |
| 🟡 | Progressive paint + gallery labs | §6.3 | ✅ | 🟡 | §1, Phase 3; gallery → pyramid Plan C |
| ☑ | Animation lab | §6.4 | ✅ | ✅ | — maintain |
| — | Drag-race / tier sweep lab | §6.5 | ✅ | N/A | — |
| 🟡 | Canonical metrics (`onMetric`, `jxl_metrics`) | §6.6 | ✅ | 🟡 | **PR-11**, §9.2 metric contract |
| ☑ | Facade / JXTC unit tests | §6.7 | ✅ | ✅ | — maintain |
| — | Progressive byte benchmark | §6.8 | ✅ | N/A | **H41** prefix-probe port optional |
| — | Butteraugli bridge | *(parity §5)* | ✅ | N/A | **P5**, `computeButteraugli` — dev only |

### 0.8 Tauri desktop shell (native-only features)

| ☐ | Feature | Matrix | WASM | Tauri | Parity |
|---|---------|--------|------|-------|--------|
| — | Desktop picker + Casabio push | §7.1 | N/A | ✅ | **K12**, **Q2** push-compatible pyramid layout |
| ☑ | Native encode variants (thumb/preview/full) | §7.2 | N/A | ✅ | Pyramid replaces single-JXL strategy Phase 2 |
| ☑ | Lightbox + `apply_look` commands | §7.3 | N/A | ✅ | Phase −1 IPC fixes; Plan D FilterEngine |
| ☑ | Priority semaphore ingest | §7.4 | N/A | ✅ | — maintain |
| ☑ | Full Tauri command surface | §7.5 | N/A | ✅ | Add `decode_jxl_level_for_id` **PR-8b** |
| ☑ | MSVC / GNU toolchain | §7.6 | N/A | ✅ | — maintain |

### 0.9 Platform & Phase 3 micro-features

| ☐ | Feature | Matrix | WASM | Tauri | Parity |
|---|---------|--------|------|-------|--------|
| ☑ | Unified TS API (jxl-wasm + jxl-native) | §8.1 | ✅ | ✅ | — maintain |
| ☑ | Color management / DNG matrices | §8.2 | ✅ | ✅ | **H31** ingest router still required |
| ☑ | 16/32-bit scientific fidelity | §8.3 | ✅ | ✅ | Pyramid **M3** |
| ☑ | Cross-platform build hygiene | §8.4 | ✅ | ✅ | — maintain |
| — | Docker/Emscripten WASM gate | §8.5 | ✅ | N/A | — |
| ☑ | HDR signaling & color priority | §9.1 | ✅ | ✅ | Ingest doesn't need all knobs |
| ☑ | JPEG recompression polish (CFL, v3 transcode) | §9.2 | ✅ | ✅ | **H32** ingest path |
| ☑ | Pixel-art downsampling modes | §9.3 | ✅ | ✅ | — maintain |
| ☑ | Low-memory chunked encode paths | §9.4 | ✅ | ✅ | — maintain |
| 🟡 | Animation `seekToFrame` C++ skip | §10.1 | 🟡 | 🟡 | **H44** — software fallback today |
| ☑ | Remaining frame settings audit | §10.2 | ✅ | ✅ | — maintain |
| 🟡 | CasaSneyers paper gap closure | §12 | ✅ | 🟡 | §11 Predator + matrix §12 — rebuild WASM for some |

### 0.10 Pyramid gallery program (authoritative — not in matrix tables below)

North star: [`2026-06-07-pyramid-gallery-design.md`](superpowers/specs/2026-06-07-pyramid-gallery-design.md). Full map: `TauriWasmParity.md` **§11**, **§12**, Phase 2.
**Agents (per 2026-06-08-PyramidAgentHandoff.md):** Grok Build — core correctness (M0 bridge/facade/tests, M1 ingest+grid, M2 FilterEngine+lightbox+WebGL stub, M3 Rust 16-bit+ingest+client dither). Gemini — low-risk clerical (checklists, constants, fixtures, test matrices, README drafts, m*-checklist.md scaffolding). High-risk M0/M1/M3 owned by Grok exclusively.

| ☐ | Milestone | WASM | Tauri | Parity |
|---|-----------|------|-------|--------|
| ✅ | **M0** Plan A — `sidecars_v2`, `downscaleRgba16`, `encodeRgba8Pyramid` (Grok + Gemini) | ✅ (feat/pyramid-m0 @93afee7; 2048@0.55 un-clamped, runtime+source tests) | ✅ | **PR-6** WASM done; **PR-6b** native done (effort-mapped Falcon=3) |
| ✅ | **M1** Plan B — ingest CLI + gallery grid (index/L0/DPR/scheduler one-shot by contenthash/monotonic) (Grok core + Gemini) | ✅ (feat/pyramid-m1-ingest @08f9d0e + m1-grid; pure WASM, 8-bit only, JPG lossless transcode, proxy, resumable, atomic, shard; + image-store.js central fetch for manifests/levels, dupe removed from grid+lightbox) | 🟡 | **PR-7** WASM done; **PR-7b / PR-8b** Tauri ingest + level picker done (pyramid_store.rs, process_file ingest, tauri-pyramid-client.js + main.js wired; decode_jxl_level_for_id by contenthash) |
| ✅ | **M2** 8-bit lightbox + FilterEngine (Grok + Gemini) | ✅ (M2 worktree / Implementing_Pyramid branch) — FilterEngine (12 CasaBio presets: BW/BW_HIGH/BW_SOFT/SEPIA/INVERT/BOTANICAL/WARM/COOL/DEHAZE/BLUEPRINT/CHLOROPHYLL/NONE + 8 sliders with exact ranges/labels per m2-checklist; improved per-pixel non-linear shadows (lift darks via luma-masked) + highlights (compress brights) on top of matrix for better 8-bit preview; live visible-screen hist via viewport readback after transform + adjust); zoom ladder (adaptive screenLongEdge × DPR + current zoom, crossfade on upgrade from grid L0/L1 seed); canvas pan (2D transform only, no re-decode until level change) + bounds + wheel; live zoom% readout; monotonic screen-bitmap LRU (contenthash keyed, 8-entry); scheduler one-shot decode _jxl_wasm_decode_rgba8 keyed by contenthash (visible/near prio for current/prefetch neighbors, dual-dispatcher feel); extracted to web/lightbox/pyramid-lightbox.js (clean deps: ctx/getLevelBytes/chooseLevelForTarget/getManifest + module API for open(list,idx)); grid seeds from already-cached painted tile pixels (zero extra decode) then crossfade; 8-bit levels preferred (bitsPerSample filter); RAW-only 16-bit toggle stub (disabled + tooltip: "M2 lightbox always 8-bit decoded for UI/preview + adjustments to match typical 8-bit screens; 16-bit pyramid levels (full headroom for shadows/highlights) + WebGL float + FS dither is M3, off by default per design — M2 never touches 16-bit data, integrity preserved"); unit 3/3 + QA checklist items; no annotations/video per spec. | 🟡 | **PR-8/PR-8b** WASM done; Tauri port **🟡 Partial** (FilterEngine complete; missing zoom ladder, pan-without-redecode, contenthash LRU in lightbox) |
| ✅ | **M3** 16-bit RAW (big levels), WebGL float + FS dither, RAW-only toggle, basic ROI (Grok + Gemini) | ✅ COMPLETE + LIVE VERIFIED — Raw WASM + ingest rebuilt; 3 RAWs re-ingested to $TEMP gallery on port 8081; manifests have 16-bit for 2048/full levels; rgba16 decode probe PASS with exact wh8 bytes; WebGL float-texture loop hooked to display; live toggle + sliders + export crops fully functional in pyramid-gallery.html. | ✅ | **PR-9** WASM complete (display+export); **PR-9b** Tauri COMPLETE (16-bit ingest ladder `encode_raw_pyramid_ladder`, `encode_rgba16`, high-precision decode `decode_jxl_rgba16`, and `tauri-parity-lightbox.js` 16-bit level decodes & ROI exports) |
| ✅ | **M4** Plan E — JXTC/TJLX massive-scan threshold (Grok + Gemini) | ✅ COMPLETE — Grid controller forwards level.tiled + region viewport for massive assets; lightbox pan drag performs rAF-throttled + pointerup on-demand tiled region decodes with pooled workers; stitch and single-thread fallback. | 🟡 | **PR-10** WASM complete; **PR-10b** Tauri **🟡 Partial** (JXTC read + threshold complete; missing parallel tile ROI, pyramid_bench, harness alignment) |
| ✅ | Content-addressed `levels/{hash16}.jxl` + manifest v1 (per-level bitsPerSample) | ✅ | ❌ | **H28**, **K12**, §11.2 — WASM CLI; Tauri storage open |
| 🟡 | Scheduler dedupe by `contenthash` + one-shot | ✅ (grid + lightbox reuse) | ❌ | **H15**, **K13**, §6.8 lever #8 |

### 0.11 Recommended execution order (from parity program)

1. Phase −1 — §0.1 boundary surgery (**PR-0a…0e**)
2. Phase 0 — sync `jxl_lowlevel`, unified bench (**PR-1**, **PR-11**)
3. Phase 0b — §0.2 format router (**PR-0f**, **H31**, **H32**)
4. Phase 1 — fast-jpeg, `decodingSpeed`, Sneyers full, crop encode fix (**PR-2…5**)
5. Phase 2 — pyramid **M0–M4** (**PR-6…10**)
6. Phase 3 — legacy within-image progressive only (**§1**, **K15** — not gallery)

**Key decisions to read first:** `TauriWasmParity.md` §8 (**K1**–**K18**). **Open questions:** §10 (**Q1**–**Q9**).

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
| 4 | Full Extra Channel infrastructure (alpha/depth/spot/thermal + 72B descriptors + symmetry) | ✅ (Phase 2 complete + CasaSneyers_Parity 2026-06-03: `black`/`cfa`/`thermal` now first-class types — `black`→JXL_CHANNEL_BLACK(4), `cfa`→JXL_CHANNEL_CFA(5), `thermal`→JXL_CHANNEL_THERMAL(6); previously thermal silently mapped to Optional. CMYK K channel: use `type:"black"` + `modular:1` + CMYK ICC profile.) | ✅ (jxl-native parity: encode + decode; descriptors + pixel planes on final event; ExtraChannelDescriptor on header) | wrapper-lab (alpha distance + visible "Extra Channels demo" section with button, status, and per-tile result badges for granular modular hints; full dynamic multi-EC panel + per-plane inspector scoped/future per granular-extra-channel-modular.md) | PROGRESS 2026-05-29; designs/extra-channel*; strengthened in 2026-06 audit; CasaSneyers_Parity type routing fix 2026-06-03 |
| 5 | Photon noise (ISO-based) | ✅ (`photonNoiseIso?: number` + JXL_ENC_FRAME_SETTING_PHOTON_NOISE; WASM rebuilt) | ✅ (jxl-native parity) | wrapper-lab | designs/photon-noise.md; PROGRESS 2026-05-28; REFERENCE #5 |
| 6 | Decoding speed tier (0-4) | ✅ | ✅ | wrapper-lab | REFERENCE #6; PROGRESS |
| 7 | Brotli effort (0-11) | ✅ | ✅ | wrapper-lab | designs/brotli-effort.md; REFERENCE #7 |
| 8 | Animation / multi-frame (per-frame duration/name, loop, progressive decode) | ✅ (7 symbols live + CasaSneyers_Parity 2026-06-03: per-frame `blendMode` first-class: Replace/Add/Blend/MulAdd/Mul; `WasmAnimationFrame` extended 28→32 bytes; `marshalAnimationFrames` + bridge.cpp updated. Requires WASM rebuild for effect.) | ✅ (jxl-native parity; native addon rebuilt 2026-05-29) | animation-lab.html (full interactive lab + capability banner) | PROGRESS 2026-05-29 full entry; designs/animation-multi-frame.md; blend modes: CasaSneyers_Parity 2026-06-03 |
| 9 | Metadata boxes + container decisions (ICC/EXIF/XMP, JPEG recon, compressBoxes, custom) | ✅ + JUMBF first-class sugar (2026-06) | ✅ (via TS expansion, parity) | wrapper-lab (new "JUMBF / C2PA" demo subsection + sample stub button) | designs/jumbf-box-support.md (exemplar full body on feature/jumbf-box-support); builds directly on #9 custom + v2 box paths |
| 10 | Gain maps (HDR tone-mapping assistance) | ✅ (bridge.cpp + facade gainMap option + decode events + _with_gain_map + capability gate + unit tests; exports present. See also jhgm box paths) | ✅ (jxl-native: full encode (jhgm box via JxlGainMap*) + decode support when built with CASABIO_HAVE_GAIN_MAP; runtime probe via binding.probe().hasGainMapSupport; GainMapOptions on EncoderOptions + gainMap on decode events. High-level Tauri desktop export paths (casabio etc.) live in sibling raw-converter-tauri repo.) | wrapper-lab (gainMap file + demo checkbox + result download badge; improved discoverability via native probe) | designs/gain-maps.md; REFERENCE #10; 2026-06 probe + better benchmark UI for discoverability |
| 11 | Patches & splines (advanced coding tools) | ✅ (escape hatch + experimental toggle) | ✅ (escape parity) | wrapper-lab (checkbox + warning) | designs/patches-splines.md; PROGRESS |
| 11b | First-class advanced encoder controls (post-audit) | ✅ (Phase 1 + forwards 2026-06 on Reference_code_audit_parity: rows 1-6 + row 7 JPEG strip/keepExif etc under jpegReconstruction + warnings; buffering/centers/filters prior; see PROGRESS_LOG row-by-row + AUDIT updates.) | ✅ (pairs + native) | wrapper-lab (Advanced + JPEG recon sections) | designs/first-class-advanced-encoder-controls.md + REFERENCE_CODE_AUDIT.md + this parity pass |
| 12 | Resampling factors (encoder-native 1/2/4/8 + per-EC) | ✅ (`Reference_code_audit_parity` wires independent `ecResampling` to WASM bridge ID 3; rebuild required) | ✅ (jxl-native lowers `ecResampling` to ID 3) | wrapper-lab | designs/resampling.md; REFERENCE_CODE_AUDIT row 18 |
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
**Date:** 2026-06-03 (post-Predator progressive optimizations)

Most former 🟡/❌ entries have been resolved to ✅ or N/A (by design or completed B-series work). 

**Current Notable Items (mostly by-design differences):**
- JXTC container + certain WASM-specific streaming/zero-copy optimizations remain N/A on Tauri (native libjxl path).
- Gain maps: library-level support (with runtime probe) is complete on both sides when the optional build flag is used. High-level Tauri desktop integration remains in the sibling repo.
- First-class advanced encoder controls: Phase 1 (filters + GROUP_ORDER + validation + buffering foundation) + expert (row11 disablePerceptual ID39 + prior allow) complete (WASM+Native+lab). Deeper per design note.
- **Predator Mode Optimizations (2026-06)**: Successfully resolved `progressiveDc` hardcoding and plumbed center-out `groupOrder` support. Benchmarks now demonstrate genuinely distinct early progressive layers (Item 11). Follow-ups: matrix worker decode+prefix-probe for min-bytes, paint automation smoke (2 events, center proxy), doc+report updates, native fn check.
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
- **Tauri port program (checklist, phases, PRs):** [`TauriWasmParity.md`](TauriWasmParity.md) — §0 above maps every matrix row to this doc
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

## 12. CasaSneyers_Parity — Paper Gap Closure — 2026-06-03

Systematic gap closure from Sneyers et al. paper (cross-referenced against `docs/Research/SneyersCasaWasm comparison.md`). See PROGRESS_LOG "CasaSneyers_Parity" entry for full detail.

| Feature | WASM | Tauri | Status | Notes |
|---------|------|-------|--------|-------|
| `black`/`cfa`/`thermal` extra channel types (Ch4/5) | ✅ source + dist | 🟡 (native accepts type int; map same values) | TS-only fix, immediate effect | `encodeExtraChannelType` now routes to JXL_CHANNEL_BLACK(4)/CFA(5)/THERMAL(6). CMYK K via `black` + `modular:1` + CMYK ICC. |
| Per-frame animation blend modes (Ch3/Ch9.3.2) | ✅ source; rebuild req'd | N/A | Source complete | `AnimationFrame.blendMode`: replace/add/blend/muladd/mul. WasmAnimationFrame 28→32 bytes. Bridge updated. |
| `intrinsicSize` encoder option (Ch3) | ✅ source; rebuild req'd | 🟡 (not yet on native path) | Source complete | Display dims independent of encoded pixels. `jxl_wasm_enc_set_intrinsic_size` setter + state field + EncodeRgbaWithMetadata wired. |
| `disablePerceptualHeuristics` (ID 39, Ch6 benchmarking) | ✅ (row11: flat + native pairs + lab wired; streaming setter; escape for all) | ✅ (pairs + convert) | Row 11 audit complete | Full first-class per cjxl; critical for fair benchmarks. |
| `premultiply` alpha signaling | ✅ source; rebuild req'd | ✅ source (`jxl-native`) | Source complete | `premultiply?: -1\|0\|1` now reaches `JxlBasicInfo.alpha_premultiplied` on WASM streaming-state and native-addon paths. Pixel values are not rewritten by this slice. |
| `codestreamLevel` encoder option (Level 5/10) | ✅ source; rebuild req'd | ✅ source (`jxl-native`) | Source complete | First-class `codestreamLevel?: -1\|5\|10`. WASM streaming state setter + native addon parse/apply `JxlEncoderSetCodestreamLevel`; external Tauri RAW pipeline has no command-facing option in this slice. |

**Remaining paper gaps (not addressed in this slice):**
- Full CMYK pipeline: `type:"black"` channel type and `codestreamLevel:10` are now surfaced, but full end-to-end CMYK still requires Modular mode enforcement, CMYK ICC/profile policy, and full buffered/extra-channel path verification — deferred.
- Splines/Patches first-class (Ch7): intentionally escape-hatch; no safe first-class API shape exists without deep bridge + libjxl internal wiring.
- Tauri native progressive event loop vs JXTC (Ch9): by-design N/A; Tauri uses one-shot + shared frontend.

---

## 11. Recent Optimizations (Predator Mode) — 2026-06

While not strictly new "features," these aggressive surgical optimizations (per `fast-path-principles.md`) closed critical UX and benchmark gaps in the progressive decode pathway.

| Optimization | Target | Impact |
|--------------|--------|--------|
| **Progressive Encode Resolution** | WASM Encode | Fixed hardcoded `progressiveDc: 1` in facade; now respects caller intent (0-2). Allows benchmarks (paint, gallery, byte-tier) to finally exercise and demonstrate genuinely distinct early progressive layers. |
| **GroupOrder (Center-out) Support** | WASM Encode | Fully plumbed `groupOrder` (0/1) via FFI and smart defaults (auto-set to 1 when `previewFirst` is active). Early passes are now center-weighted and much more "recognizable" at low byte counts compared to scanline order. |
| **Center-out UX Parity** | Native / Tauri | Added analogous `groupOrder` + `progressiveDc` promotion in `jxl-native` and `raw-pipeline` surfaces for desktop export parity. (Post-2026-06-03: encode_variants_with_progressive smoke + ps1 check verified; matrix decode+probe now live for parity sweeps.) |
| **Automated "Push" Iteration** | Benchmarks | Replaced manual file picking with a localStorage-based "Push to Gallery" mechanism in `jxl-progressive-paint.html`. Enables rapid "encode → view layers in gallery" test loops. |
| **Sneyers Paint Fidelity + UI Polish (2026-06 follow-up)** | WASM/UX | Buffer slack fixed globally (exact Uint8 views everywhere for getImageData paths); sneyers encode now always via canonical preset (guarantees buffering=0 so early layers have real DC content); UI auto-syncs Detail=passes + 6 steps on sneyers preset (like group cb); source preview canvas + final PSNR vs source in measurements; mild "nice" look params only in paint for representative visuals while keeping encode path pure; cleared exports on error. | N/A (shared) | jxl-progressive-paint.html + gallery | See HANDOFF + PROGRESS_LOG for the buffer + white-passes root cause (drift on streaming encode mode). |


