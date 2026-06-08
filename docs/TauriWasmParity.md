# Tauri ↔ WASM Parity — Spec & Implementation Plan

**Date:** 2026-06-07 (rev 5 — Gemini progressive-lessons triage)
**Branch context:** WASM research on `feat/fast-jpeg`; parity groundwork on `origin/tauriparity`; Tauri app in sibling repo `C:\Foo\raw-converter-tauri`  
**Status:** Implementation in progress (2026-06-09 update) — Phase −1 mostly landed (Tauri IPC + `web/main.js` id-cache wiring); 
- **M0 WASM complete** (Grok Build + Gemini): feat/pyramid-m0-wasm-primitives (sidecars_v2 per-level no 2048 floor clamp, downscaleRgba16, encodeRgba8Pyramid + tests).
- **M1 WASM complete** (Grok core + Gemini clerical): feat/pyramid-m1-ingest-cli + m1-gallery-grid (`@casabio/pyramid-ingest` full + grid: index/L0/DPR/scheduler contenthash one-shot/monotonic/crossfade/viewport+prefetch/cancel/LRU).
- **M2 WASM complete** (Grok + Gemini): 8-bit lightbox + full FilterEngine (12 presets, 8 sliders, live histo, zoom/pan, dither stub).
- **M3 WASM foundation** (Grok): Rust 16-bit RGB16 expose (OUT_FULL_16, take_rgb16_full), ingest 16-bit ladder/manifest/raw-backend, client 16 toggle + dither16To8.
PR-0d fast-jpeg + PR-6b/PR-7b native ports open. Full rebuild + bun tests + visual before merges (per handoff).
**Audience:** Engineers porting WASM speed/efficiency wins, **boundary-crossing discipline**, pyramid gallery architecture, and features to the Tauri desktop build  
**Gallery north star:** `docs/superpowers/specs/2026-06-07-pyramid-gallery-design.md` — progressiveness = **resolution level ladder**, not within-image DC progressive  
**Agents (per PyramidAgentHandoff 2026-06-08):** Grok Build — all high-effort core (M0 primitives, M1 ingest+grid, M2 FilterEngine+lightbox, M3 16-bit Rust/ingest/client foundation; worktrees + commits + tests per plans). Gemini — clerical only (constants, fixtures, test matrices, README drafts, m*-checklists, this doc scaffolding). High-risk bits (bridge, ingest, scheduler reuse, 16-bit expose) exclusively Grok per spec.

---

## 1. Progressive UX Lessons (WASM labs → Tauri policy)

Grounded in `HANDOFF-progressive-paint-sneyers-gallery-issues.md`, `HANDOFF-single-progressive-progressive-tuning-2026-06-05.md`, `HANDOFF-progressive-paint-speedup-A3-A4-2026-06-06.md`, and `Opus4.8ThrottleFindings.md`.

**Scope:** These apply to **within-image progressive** diagnostic/legacy paths (Phase 3, K15). They do **not** override the gallery north star (pyramid L0 ladder, K2) or product local-bytes policy (no `emitEveryPass` paint loop, K6/H42).

### 1.1 Canvas ImageData slack (buffer security) — **integrate**

Sneyers/gallery corruption (noise, channel swap, white passes) traced to `getImageData(...).data.buffer` without `byteOffset`/`byteLength` — backing store can exceed `4×w×h`.

- **WASM fix:** exact views everywhere (`HANDOFF-progressive-paint-sneyers-gallery-issues.md`); see `toArrayBuffer` slice guard in decode-handler (H26 analogue).
- **Tauri parallel (H3, H26):** validate IPC/`Response` payloads are exactly `w×h×4` (RGBA8) or `w×h×8` (RGBA16); never trust caller length alone.
- **Encode path:** same rule if WebView ever sends canvas pixels back for re-encode.

### 1.2 Progressive chunk yield + opportunistic flush — **WASM diagnostic only; partial Tauri**

Collapsed progressive paint (2 frames instead of N) came from single-blob push with no event-loop yield **on diagnostic pages** (`progressiveDetail === 'passes'` or throttle > 0 per `Agents.md`).

| Context | Chunk yield (`sleep(0)`) | Opportunistic flush |
|---------|--------------------------|---------------------|
| Diagnostic / `passes` detail | **Required** — chunk-feed + yield between pushes | **Required** — one `TryFlushProgressiveImage` per `input_generation`; no checksum dedup on this path (`Agents.md` DONOTCHANGE) |
| Product gallery / local bytes | **Not required** at throttle 0 — one push OK (`web/README.md`) | Same bridge contract; UI must not paint every flush (K6) |
| Tauri native decode | **No JS event-loop analogue** — `jxl_lowlevel` emits on `FRAME_PROGRESSION`; yield between *chunk pushes* is N/A when bytes are in memory | Port flush semantics; optional **hash gate before texture upload** (H43) is a *UI* dedup, not bridge checksum dedup |

Do **not** advise `sleep(0)` inside `spawn_blocking` — wrong layer. Tauri progressive = emit frames on native progression boundaries + binary texture upload, not JS chunk pacing.

### 1.3 Render speedups A3/A4 — **integrate as principles**

| Milestone | WASM (web paint lab) | Tauri parallel |
|-----------|----------------------|----------------|
| **A3** persistent canvases | Reuse slot + thumb canvases; no per-pass `makePassCanvas` | Reuse egui/wgpu texture; patch in place on refinement passes |
| **A4** stats gating (`?stats=1`) | `analyzeProgressiveFrame` O(W×H) off by default | Gate heavy per-pass analytics behind diagnostic flag only |
| **A2** rAF coalesce (related) | `collectProgressivePaintEvents` | Coalesce WebView texture uploads if multiple passes arrive same frame |

### 1.4 RAW "nice preview" tone — **viewer QA only; do not port to ingest**

Paint lab only (`jxl-progressive-paint.js`): exposure +0.3, contrast +0.1, saturation +0.15, vibrance +0.1 for ORF **display** so Gobabeb visual QA looks representative.

- **Ingest / parity benches:** strict 0/NaN — unchanged (K1).
- **Tauri:** optional same defaults in **lightbox preview UI** only; never in `process_file` or pyramid encode input.

### 1.5 PSNR ≥ 40 dB — **progressive encode regression gate; not general parity**

`computePsnrVsFinal` in paint lab; target from `truly-progressive-jxl-design.md` / `suggested-settings.md` — final progressive pass vs resized source.

- Use in **native progressive encode/decode regression tests** when validating Sneyers assets (Phase 3).
- Not a gate for pyramid level ladder or one-shot grid seed (M1).

---

## 2. Goal

Achieve **feature and timing parity (or better)** for the Tauri desktop app versus the best current WASM/browser paths, by systematically porting measured wins from the WASM campaign into native Rust while respecting the different cost model (no JS↔WASM boundary, no worker transfer tax, direct texture ownership).

**Success looks like:**

- Tauri gallery/lightbox/ingest feels as fast or faster than the best WASM paths on identical reference workloads (Gobabeb 30-file encode, P2200 11-file decode/ROI).
- Every WASM optimization that survives the cost-model filter is either ported, explicitly rejected (with citation), or marked N/A.
- One canonical measurement loop produces comparable metrics on both sides (`decode_buffer_extract_ms`, `decode_region_downsample_ms`, `source_pixels_decoded`, `time_to_first_pixel_ms`, etc.).
- **Gallery/lightbox** follows the pyramid spec: ingest builds `[256, 512, 1024, 2048]` + full levels; grid seeds L0 (~19 ms WASM / ≤25 ms native); upgrades are monotonic by `tileSize × DPR`; within-image DC progressive is **not** the primary gallery strategy (K2).

---

## 3. Source Material (Git + Code)

This plan is grounded in the following artifacts — not re-derived from memory.

| Source | What it contributes |
|--------|---------------------|
| `docs/HANDOFF-tauri-parity-2026-06-03.md` | Encode direct-RGBA done; ROI/progressive/metrics open items; harness design |
| `docs/HANDOFF-tauri-parity-continuation-2026-06-04.md` | `jxl_lowlevel` extraction; pre-crop ROI simulation numbers; wiring recipes |
| `docs/HANDOFF-progressive-paint-sneyers-gallery-issues.md` | Slack buffer safety fix (`new Uint8Array(buf, offset, len)`), Sneyers buffering=0 encoder preset integration, ORF nice-previews |
| `docs/HANDOFF-single-progressive-progressive-tuning-2026-06-05.md` | Progressive chunk-yielding strategies (`sleep(0)` vs `nextPaint()`), TryFlushProgressiveImage contracts, throughput speed metrics |
| `docs/HANDOFF-progressive-paint-speedup-A3-A4-2026-06-06.md` | Web progressive paint speedups (A3 persistent canvases, A4 stats gating via `?stats=1`) |
| `docs/superpowers/specs/2026-06-06-progressive-paint-speedup-design.md` | Web speedup design spec details |
| `docs/boundary-cost-audit.md` §12–15 | Browser vs native boundary costs; Tier-1 JXTC/ROI decision |
| `docs/fast-path-principles.md` | Micro-opt hunting method (shared `raw-pipeline`) |
| `docs/FEATURE_PARITY_MATRIX.md` | Full feature inventory; remaining gaps as of 2026-06-03 |
| `docs/suggested-settings.md` | Opposite rules: browser prefers JS `rgb_to_rgba`; native prefers `process_rgba` |
| `docs/Grok-Handoff-FastJpeg.md` | `crates/fast-jpeg` — DCT-domain JPEG decode; 2.3× pipeline win |
| `docs/superpowers/specs/2026-06-07-pyramid-gallery-design.md` | **Authoritative gallery program** — M0–M4 milestones, ingest/storage/client, non-goals (§11), success criteria (§15); DC demoted for gallery |
| `docs/superpowers/plans/2026-06-07-pyramid-wasm-primitives.md` | **Plan A (M0):** `encodeRgba8Pyramid`, `downscaleRgba16` bridge primitives — **completed** Grok Build (worktree + tests) |
| `docs/superpowers/plans/2026-06-07-pyramid-ingest-cli.md` | **Plan B (M1):** `@casabio/pyramid-ingest` — content-addressed levels + manifest/index + proxy/shard + gallery grid (index/L0/DPR/scheduler one-shot by contenthash) — **completed** Grok core + Gemini (worktrees @08f9d0e + grid) |
| `docs/superpowers/specs/pyramid-gallery-m2-checklist.md` + m0/m1/m3/m4 | M2 lightbox/FilterEngine (12 presets + 8 sliders + histo + zoom/pan + dither) — **completed** Grok + Gemini scaffolding |
| Pyramid M3 foundation | 16-bit RAW (Rust expose + ingest 16 levels + client toggle/dither) — Grok high-effort start (M3 worktree) |
| *(planned)* Plan E — massive scans | JXTC tiled top level (>40 MP), parallel ROI decode (M4) |
| `docs/Opus4.8ThrottleFindings.md` | Progressive paint policy: `lastPasses` + `emitEveryPass` costly for local bytes |
| `docs/INCOMPLETE PLANS.md` | Tauri section checkboxes (ROI decode still open in this repo's tracker) |
| `origin/tauriparity` vs `feat/fast-jpeg` diff | `jxl_lowlevel.rs` + `raw_decode_bench.rs` extensions (+543 lines) not on tauriparity |
| `C:\Foo\raw-converter-tauri\src-tauri\src\pipeline.rs` | Live Tauri implementation: TJLX, subject crops, DC preview, `jxl_metrics` |
| Pyramid WASM worktrees (M0/M1/M2/M3) + docs/superpowers/specs/*-checklist.md + m*-test-matrix + PyramidAgentHandoff.md | Grok core + Gemini clerical updates reflected here + FEATURE_PARITY_MATRIX.md (M0/M1 complete WASM, M2 lightbox/FilterEngine complete, M3 16-bit foundation) |
| `timings/fastest/*.mjs` | Empirical pipeline timings (pyramid, fastjpeg, optimal, inbetween) |
| `C:\Foo\raw-converter-tauri\docs\Claudes Opus 4.7 Improvement Strategy.md` | Tauri IPC boundary diagnosis (JSON u8 bloat, binary Response fixes) |
| `packages/jxl-wasm/src/bridge.cpp` | `MakeBufferFromOwned`, `TryFlushProgressiveImage`, sidecar chain, direct decode buffer |
| `packages/jxl-wasm/src/facade.ts` | `copyOrBorrowInput`, `takeBuffer`, `applyRegionAndDownsample` |
| `packages/jxl-session/src/util.ts` | `toTransferableBuffer` — ownership-safe transfer |
| `packages/jxl-worker-browser/src/{decode,encode}-handler.ts` | `copyInput:false`, `postMessage` transfer lists, `toArrayBuffer` |
| `packages/jxl-scheduler/src/scheduler.ts` | Dedupe, bufferedChunks, `waitForDrain`, `scheduler_queue_wait_ms` |

**Repo topology:**

```
raw-converter-wasm/          ← WASM bridge, web/, packages/jxl-*, crates/raw-pipeline (canonical)
raw-converter-tauri/         ← src-tauri/, vendored raw-pipeline/ (must stay synced)
```

`src-tauri` is **not** in the WASM workspace; parity work spans both repos with `crates/raw-pipeline` as the shared kernel.

---

## 4. Boundary Taxonomy — The WASM Campaign Was a Boundary Campaign

The WASM optimization work was not only per-pixel math. A large fraction of measured wins came from **reducing how often, how much, and in what shape** data crosses boundaries. Tauri does not have a JS↔WASM heap, but it **does** have boundaries — and several WASM "hacks" have direct parallels.

### 4.1 Boundary map (both stacks)

| Boundary | WASM stack | Tauri stack | Same problem? |
|----------|------------|-------------|---------------|
| B1 Process ↔ foreign runtime | JS ↔ WASM heap (`_malloc` + `set`) | Rust ↔ WebView (invoke IPC, events) | **Yes** — different runtime, copy/encode tax |
| B2 Thread ↔ thread | Main ↔ Worker `postMessage` + transfer | `spawn_blocking` ↔ async runtime; bg prefill tasks | **Partial** — no detach, but clones + channel overhead |
| B3 Codec ↔ consumer | `takeBuffer` out of bridge | `pack_rgb_response` → `Response::new` | **Yes** — extra pack/copy on hot returns |
| B4 Full buffer ↔ right-sized view | `applyRegionAndDownsample`, JXTC ROI, pyramid level | TJLX ROI, subject crop cache, (missing pyramid) | **Yes** — ship pixels you need, not full frame |
| B5 Repeated ownership handoff | `copyOrBorrowInput`, `exactBuffer`, `toTransferableBuffer` | `Arc` clones vs `Vec` clones; `(*arc).clone()` | **Yes** — ownership discipline |
| B6 Deduped work | Scheduler `DedupeRegistry` by `sourceKey` | `jxl_cache` / `subject_jxl_cache` by `id` | **Partial** — id dedupe yes; content-hash dedupe no |
| B7 Encode setup batching | Sidecar chain one crossing; animation `mallocAndCopy` cluster | Per-tile TJLX loop; per-subject encode loop | **Yes** — N mallocs / N encodes vs one batched path |
| B8 Progressive paint | Worker → main per-pass pixel transfer | `jxl_dc_preview` base64 event; future pass uploads | **Yes** — shape + frequency of partial frames |
| B9 Lazy delivery | Session streaming; progressive flush before final | `file_thumb_fast`; dims-only `ProcessResult`; id-based decode cmds | **Partial** — several patterns landed; batch path still heavy |

**Key insight:** Tauri eliminated B1's WASM heap tax but **reintroduced a different B1** — JSON serialization of `Vec<u8>` as decimal integer arrays (~4× wire bloat + parse cost). The Opus 4.7 Tauri strategy doc quantifies this as the **single biggest remaining user-visible win** (slider 40–80 ms → 4–12 ms).

### 4.2 What truly vanishes in Tauri (do not port literally)

| WASM-only | Why no literal port |
|-----------|---------------------|
| Emscripten `_malloc` / `HEAPU8.set` | No linear memory bridge |
| `copyInput` on worker encode chunks | No worker heap marshal |
| COOP/COEP + WASM MT tier matrix | Native threads via `rayon` / libjxl |
| Browser `take_rgba()` preference | Measured regression in browser; **inverse rule** in native (`process_rgba`) |
| `postMessage` detach semantics | Rust ownership instead |

### 4.3 What must port as *principle* (even when mechanism differs)

| WASM boundary hack | Principle | Tauri parallel (mechanism) |
|--------------------|-----------|----------------------------|
| `copyOrBorrowInput(..., false)` | Don't copy if caller transfers ownership | `Arc` handoff into `spawn_blocking`; never `(*arc).clone()` full `Vec` on hot paths |
| `toTransferableBuffer` / `exactBuffer` | Normalize to standalone buffer only when view is sliced | `pack_rgb_response`: avoid second full copy when payload already in owned `Vec` |
| `takeBuffer` + `MakeBufferFromOwned` | Transfer ownership out of codec; no memcpy on exit | Return `Response` from decode cache pointer; consider `bytes::Bytes` / shared buffer |
| Keep decode in codec; ship region only | `source_pixels_decoded` win | TJLX / subject JXL / `decode_jxl_region_for_id` — **extend** to pyramid level pick |
| Sidecar chain / one encode crossing | One marshal for N outputs | Port `EncodeRgba8WithSidecars` v2 — replace N separate `encode_jxl` calls |
| `TryFlushProgressiveImage` + borrowed snapshot (R4) | Reuse decode buffer; copy snapshot once per pass | `jxl_lowlevel` + upload only **changed** pass to WebView; hash-dedup like bridge R6 |
| `suppress_duplicate_progress` (R6) | Skip identical progressive frames | Native progressive: don't re-emit `jxl_dc_preview` if hash unchanged |
| Scheduler dedupe | Collapse duplicate decode/encode | Content-addressed pyramid levels + decode dedupe by `contenthash` |
| Lazy dims / cache-by-id | Don't ship full payload until needed | `lightbox_width/height` without pixels ✅; extend to **drop `jxl` from `ProcessResult`** (already in `jxl_cache`) |
| `decodingSpeed: 2` | Tune decode cost at boundary exit | Wire `JxlDecoderSetDecodingSpeed` / encoder mirror in native paths |
| `applyRegionAndDownsample` before handoff | Downsample before boundary cross | Decode pyramid L0/L1 **instead of** full decode + `downscale_rgb8` in bg task |
| Animation arena / batched malloc | One alloc for N frames | Tile encode arena: one scratch buffer for TJLX tile rasterization loop |
| `mmap` / zero-copy file read | Don't copy file into RAM before parse | Tauri **already ahead** (`memmap2` in `process_file`) |

### 4.4 WASM patterns to reject in Tauri (behavior, not boundary discipline)

See `docs/rejected optimizations.md`. These are **product policy** rejects, not permission to ignore boundaries:

- Forcing `emitEveryPass` + full-frame paint per pass on **local bytes** (Opus4.8: 3–9.5× vs one-shot)
- Heavy chunk-feed + `sleep(0)` when all bytes are in memory
- Scheduler drain callbacks inside facade/decoder (wrong layer)
- Pixel buffer pools across **detached** transferred buffers (WASM-specific lifecycle)

---

## 4A. Boundary Hack Inventory (WASM source → Tauri status)

Detailed trace from `boundary-cost-audit.md`, `bridge.cpp`, `facade.ts`, worker/scheduler packages, and live `raw-converter-tauri` code.

| ID | WASM hack / site | What it saves | Tauri parallel | Status | Action |
|----|------------------|---------------|----------------|--------|--------|
| **H1** | `process_rgba` / direct 4ch encode (Phase 2A native) | Eliminates RGB→RGBA JS alloc on encode | `process_rgba` in `pipeline.rs` / `casabio.rs` | ✅ Done | Keep; opposite of browser `take_rgba` rule |
| **H2** | `copyOrBorrowInput` + `copyInput:false` (`encode-handler.ts:161`) | Skip chunk memcpy into WASM | Use `Arc` + `spawn_blocking` without cloning inner `Vec` | 🟡 Partial | **Fix `(*jxl_arc).clone()`** in bg prefill (`pipeline.rs:1265`); pass `Arc` into decode |
| **H3** | `toTransferableBuffer` / worker `postMessage(..., [pixels])` | Zero-copy main↔worker | `tauri::ipc::Response` binary returns | 🟡 Partial | ✅ `apply_look`, `get_lightbox`, `decode_jxl_*`; ❌ thumb in `ProcessResult` |
| **H4** | `serialize_bytes_base64` for large blobs | Avoid JSON u8 arrays | `ProcessResult.jxl` uses base64 | ✅ Done | **Next:** omit `jxl` field when `id` suffices (cache hit) |
| **H5** | `serialize_arc_vec_u8` on thumb | — | Thumb still JSON `[255,0,…]` per pixel | ❌ Gap | **P0:** base64 thumb or binary side channel; per Opus 4.7 §1 (~1.1 MB → 290 KB wire) |
| **H6** | `file_thumb_fast` early emit | Hide latency before full pipeline | Fire-and-forget JPEG extract | ✅ Done | DCT decode via `fast_jpeg`; event metadata-only; `get_fast_thumb(path)` binary Response |
| **H7** | `jxl_dc_preview` progressive first paint | Time-to-first without full decode | DC decode + event | 🟡 Partial | **Demoted for gallery** (K2) — L0 seed replaces DC; fix base64 → cache + binary fetch for legacy assets |
| **H8** | `MakeBufferFromOwned` / direct `JxlDecoderSetImageOutBuffer` (`bridge.cpp:447-449`) | No post-decode memcpy | `jpegxl-rs` / `bench::decode_*` write into `Vec` | ✅ Native ahead | `decode_buffer_extract_ms ≈ 0` measured |
| **H9** | `applyRegionAndDownsample` in facade (`facade.ts:2235+`) | Crop/downsample before JS handoff | Full decode then downscale in bg prefill | 🟡 Partial | `jxl_lb_cache` + `decode_jxl_level_for_id`; bg prefill prefers lb tier; full pyramid manifest (**PR-7b**) still open |
| **H10** | JXTC / tiled region (`decodeTileContainerRegionRgba8`) | 9–15 ms @128 px vs 2.5 s full | TJLX v2 + `decode_tiled_jxl_region` | ✅ Done | Benchmark vs WASM; align harness metric names |
| **H11** | Pre-crop dedicated JXL (harness simulation) | 0.5–2 ms @128 px | `subject_jxl_cache` + `decode_jxl_subject_crop_for_id` | ✅ Done | Remove RGBA→RGB strip on encode (`pipeline.rs:1125-1131`) |
| **H12** | Sidecar pyramid one-call (`EncodeRgba8WithSidecars` v2) | One JS↔WASM crossing for N levels | N/A — separate full JXL + N encodes | ❌ Gap | Port Plan A encoder to native `casabio_encode` |
| **H13** | `TryFlushProgressiveImage` + borrowed snapshot (R4) | Stable buffer; no flip-flop corruption | `bench::decode_libjxl_dc` one-shot | 🟡 Partial | Wire `jxl_lowlevel::decode_progressive_first_total`; emit binary frames not base64 |
| **H14** | `suppress_duplicate_progress` hash (R6) | Skip redundant paints | Not present | ❌ Gap | Add optional hash gate before WebView upload |
| **H15** | Scheduler dedupe (`DedupeRegistry`) | One decode serves N waiters | `jxl_cache` by id only | 🟡 Partial | Add content-hash dedupe when pyramid levels land |
| **H16** | `id`-based decode commands (no re-upload) | Avoid re-sending JXL bytes | `decode_jxl_*_for_id` | ✅ Done | Ensure frontend never passes full JXL when `id` known |
| **H17** | Lazy lightbox (dims only in batch result) | Keep batch IPC small | `lightbox_width/height` without pixels | ✅ Done | — |
| **H18** | `Rgb16State` / `Arc<Vec<u16>>` for sliders | O(1) clone across `spawn_blocking` | `Rgb16State.data: Arc<Vec<u16>>` | ✅ Done | — |
| **H19** | `pack_rgb_response` 4-byte header + raw RGB | Binary IPC shape | Used by `apply_look`, `get_lightbox`, decode cmds | ✅ Done | Reuse for thumb delivery; avoid re-packing same bytes twice |
| **H20** | `fast-jpeg` DCT decode (skip transcode trap) | ~7× decode stage | JPEG still shipped as bytes to WebView | ✅ Done | `fast_jpeg::decode_scaled_rgb8` in `file_thumb_fast` path |
| **H21** | Pyramid L0 one-shot decode (`pyramid-pipeline.mjs`) | ~19 ms grid seed | Not implemented | ❌ Gap | **M1 gallery north star** (spec §6); supersedes H7/DC for grid |
| **H22** | `decodingSpeed: 2` default | ~30% faster decode | Encode-time wired | 🟡 Partial | `ProcessOptions.decoding_speed` → `JXL_ENC_FRAME_SETTING_DECODING_SPEED` in `encode_jxl_with_channels` |
| **H23** | `mmap` ingest | Zero-copy file read | `memmap2::Mmap` in `process_file` | ✅ Tauri ahead | WASM still copies from JS — native wins |
| **H24** | Buffer pool / grow-only realloc (`bridge.cpp` encoder `outbuf`) | Allocator churn | `u16_pool` partial; Opus 4.7 §3 slab pool proposed | 🟡 Partial | Land `SlabPool` for rgb16/rgb8 in hot `process_file` path |
| **H25** | Animation `mallocAndCopy` cluster (`fast-path-principles.md`) | Encode setup dedup | Per-tile `Vec` in `encode_tiled_jxl` loop | 🟡 Partial | Arena tile buffer + reuse encoder instance where safe |
| **H26** | `toArrayBuffer` slice guard (`decode-handler.ts:536-540`) | Avoid defensive copy | `pack_rgb_response` always allocates new `Vec` | ✅ Done | `pack_rgb_response_arc` + `rgb_to_response_from_frame` on cache hits |
| **H27** | `previewFirst` + container JPEG recon fast path | Skip full decode for thumb | `extract_thumbnail_jpeg` only | 🟡 Partial | Combine with H20: DCT decode embedded JPEG → RGBA thumb directly |
| **H28** | Content-addressed immutable levels + CDN cache headers | Cross-session dedupe | Not in Tauri storage model yet | ❌ Gap | Pyramid manifest + `levels/{hash}.jxl` on disk (gallery spec §5) |
| **H29** | `Channel` streaming slider (`Opus 4.7` Fix C) | Avoid per-tick invoke overhead | One-shot `apply_look` invoke per slider move | ❌ Gap | Optional Phase 3 polish for live edit UX |
| **H30** | `queue_wait_ms` / `scheduler_queue_wait_ms` | Measure boundary queueing | `PrioritySem` + `queue_wait_ms` in `ProcessResult` | ✅ Done | Use in parity harness under load (scenarios C/D in `lightbox_bench`) |
| **H31** | Multi-format RAW ingest (`process_orf` / `process_dng` / `process_cr2`) | Pyramid spec §4 requires 5 formats | `process_file` format router | ✅ Done | `classify_source_format` + `decode_source_file` (ORF/DNG/CR2/JPG) |
| **H32** | JPG lossless `transcodeJpegToJxl` ingest | Pyramid full level for JPG masters (spec §4) | `jxl_native::transcode_jpeg_to_jxl` on JPG ingest | ✅ Done | Lossless transcode via `JxlEncoderAddJPEGFrame`; pyramid ladder ingest (**PR-7b**) still open |
| **H33** | `previewFirst` + `extractJpegReconstructionFromJxl` | Container JPEG recon fast path (`jxl-decode-worker.js:83+`) | Not in Tauri decode paths | ❌ Gap | Optional legacy/lightbox fast paint before pyramid L0 lands |
| **H34** | `progressiveAc` / `qProgressiveAc` encode (Sneyers) | Pass count + early-byte layout | Only `progressive_dc` + `group_order` in `ProcessOptions` | ❌ Gap | Wire IDs in `encode_jxl_with_channels`; pairs with prefix-probe tuning |
| **H35** | Lightbox viewport ROI re-decode (`computeLightboxVisibleRegion`, P3.2) | Re-decode on zoom/pan, not full frame | Tauri has `decode_jxl_region_for_id` (jxl-oxide) but lightbox prefill still full→downscale | 🟡 Partial | Wire ROI into lightbox bg path; pan = transform until level change (spec §7) |
| **H36** | Gallery coordinator + multi-file frame sync | `jxl-progressive-gallery-coordinator.js` | No Tauri equivalent | ❌ Gap | Needed for multi-RAW batch progressive gallery; superseded by pyramid grid for stills |
| **H37** | `jxl-oxide` native region decode in product | Bench proves ROI path (`bench.rs`) | Production decode uses `jpegxl-rs` full decode | 🟡 Partial | Evaluate jxl-oxide for `decode_jxl_region_*`; keep jpegxl-rs for full if faster |
| **H38** | `SlabPool` / `u16_pool` hot-path reuse | Opus 4.7 §3 — allocator churn | Planned in `pipeline-optimisation.md`; not landed | ❌ Gap | `pool.rs` + return slabs after `process_file` |
| **H39** | `decodeRegionLod` / `decodeViewport` facade helpers | Normalized ROI + LOD before handoff | Region cmds exist; no unified level/LOD picker | 🟡 Partial | Collapse into `decode_jxl_level_for_id` + pyramid manifest (H9/H21) |
| **H40** | `encodeRgba8Pyramid` / Plan A M0 | One-call pyramid encode | ✅ `exports.txt` + facade (2026-06-08) | ✅ Native encoder synced | **PR-6b** landed in Tauri vendor; **PR-7b** `process_file` pyramid ingest still open |
| **H41** | `progressive-prefix-probe` + encode matrix tooling | Tune Dc×group×effort; Gobabeb first-paint bytes | Tauri has no equivalent probe command | ❌ Gap | Port `benchmark/progressive-prefix-probe.mjs` logic to native bench (dev/harness) |
| **H42** | Product `emitEveryPass` / chunk-feed policy (Opus4.8) | 3–9.5× slowdown on local bytes if forced | Tauri Phase 3 not scoped; risk if porting web progressive paint verbatim | ❌ Policy | K6: no per-pass paint for local files; pyramid L0 for gallery |
| **H43** | Bridge R6 `suppress_duplicate_progress` | Skip identical progressive frames | Not in native `jxl_lowlevel` emit path | ❌ Gap | Hash gate before WebView/texture upload (pairs with H13/H14) |
| **H44** | `animationSeek` C++ skip (`_jxl_wasm_dec_seek_to_frame`) | Faster than decode-and-discard seek | Software fallback only on both sides | 🟡 Partial | Post-rebuild optimization; low priority vs gallery |

### 4A.1 Highest-impact boundary fixes (ordered by measured ROI)

These are **boundary** fixes — not algorithm swaps — and should run **before or alongside** pyramid/fast-jpeg feature ports:

1. **H5 + H3** — Stop JSON integer-array thumb in `ProcessResult`; deliver thumb via base64 or binary `Response` (Opus 4.7: batch IPC 3–5× smaller).
2. **H4** — Return `id` only from `process_file`; omit redundant `jxl` base64 when `jxl_cache` already holds bytes.
3. **H2 + H26** — Eliminate full `Vec` clones on bg JXL prefill; decode from `Arc<Vec<u8>>` in place.
4. **H6 + H20 + H27** — Native fast-JPEG DCT decode for `file_thumb_fast` → binary RGB thumb (not JPEG base64 relay).
5. **H7 + H13** — DC preview via cache + binary fetch, not base64 JSON events.
6. **H9 + H21** — Never decode full-res to paint downscaled lightbox; pyramid level or pre-downscaled decode target.
7. **H12** — One-call sidecar pyramid encode (boundary count at ingest).

---

## 5. Current Parity Status (2026-06-07)

### 5.1 Already at parity or native-ahead

| Area | WASM | Tauri (`raw-converter-tauri`) | Evidence |
|------|------|------------------------------|----------|
| Direct RGBA encode | `process_rgba` + encode variants | Same via `casabio.rs` / `pipeline.rs` | `INCOMPLETE PLANS` [x] encode |
| Progressive encode knobs | `progressiveDc`, `groupOrder` | `ProcessOptions.progressive_dc`, `group_order` | `pipeline.rs:313-328` |
| Integer downscale fast paths | `pipeline.rs` | Same paths in vendored `raw-pipeline` | grep "Integer fast path" |
| Subject pre-crop JXL cache | WASM JXTC + crop bench | `subject_jxl_cache` + `decode_jxl_subject_crop_for_id` | `pipeline.rs:1120-1211, 1619+` |
| Tiled ROI container | JXTC (`bridge.cpp`) | TJLX v2 (offset table, per-tile JXL) | `pipeline.rs:337-420` |
| DC first paint (legacy / non-pyramid) | `progressiveDetail: dc` | `decode_jxl_dc_inner` + `jxl_dc_preview` event | `pipeline.rs:1220-1253`; **gallery uses L0** after M1 (K2) |
| Canonical metrics | `onMetric` in facade | `jxl_metrics` event | `pipeline.rs:1298-1305` |
| Embedded JPEG fast thumb | `file_thumb_fast` pattern | Fire-and-forget `extract_thumbnail_jpeg` | `pipeline.rs:904-935` |
| Priority / queue observability | `scheduler_queue_wait_ms` | `queue_wait_ms` + `priority_sem` | `FEATURE_PARITY_MATRIX` §4 |
| Binary IPC hot paths | Worker transfer + `exactBuffer` | `apply_look`, `get_lightbox`, `decode_jxl_*` → `Response` | `pipeline.rs:658+`, Opus 4.7 §1 |
| mmap ingest | JS ArrayBuffer copy | `memmap2::Mmap` in `process_file` | `pipeline.rs:969+` |
| Id-based decode (no JXL re-upload) | Session holds compressed bytes | `decode_jxl_*_for_id` + server caches | `pipeline.rs:1591+` |

### 5.2 Boundary gaps — Tauri still paying avoidable taxes

These are **not** WASM feature gaps; they are places Tauri replicates WASM-era mistakes in a different shape (IPC instead of heap).

| ID | Symptom | Site | Est. cost (20 MP / lightbox) | WASM analogue |
|----|---------|------|------------------------------|---------------|
| B-T1 | Thumb ships as JSON u8 array in batch `ProcessResult` | `serialize_arc_vec_u8` on `RgbFrame.data` | ~290 KB → ~1.1 MB JSON per file | Pre-base64 `jxl` mistake |
| B-T2 | Redundant `jxl` base64 in `ProcessResult` when `jxl_cache` has same bytes | `ProcessResult.jxl` + `jxl_cache.put` | ~2–14 MB base64 per file in batch IPC | Double marshal of encode output |
| B-T3 | `(*jxl_arc).clone()` before bg full decode | `pipeline.rs:1265` | Full JXL bytewise copy per file | `copyOrBorrowInput` default `copy:true` |
| B-T4 | `jxl_dc_preview` ships base64 RGB in JSON event | `pipeline.rs:1235-1244` | ~100–400 KB event + parse | Worker progressive `postMessage` without transfer |
| B-T5 | `file_thumb_fast` ships JPEG as base64 | `pipeline.rs:926-928` | ~200 KB–1.2 MB per file event | ✅ Fixed — DCT decode + `get_fast_thumb` |
| B-T6 | Full JXL decode → downscale for lightbox prefill | bg task `decode_jxl_full_inner` + `downscale_rgb8` | Decodes 20 MP to show ~1800 px | ✅ Fixed — `jxl_lb_cache` tier + `decode_jxl_level_for_id` |
| B-T7 | Subject crop encode strips RGBA→RGB | `pipeline.rs:1125-1131` | Extra full-buffer alloc per subject rect | ✅ Fixed — RGBA crop encode path |
| B-T8 | `pack_rgb_response` always allocates new `Vec` | `pipeline.rs:10-15` | Header + body copy per invoke | ✅ Fixed — `pack_rgb_response_arc` |
| B-T9 | `get_jxl_lightbox` clones `RgbFrame` under mutex | `pipeline.rs:678` | Arc clone OK; still repacks bytes in `rgb_to_response` | Minor; fix B-T6 first |

**Opus 4.7 Tauri strategy** (`raw-converter-tauri/docs/Claudes Opus 4.7 Improvement Strategy.md`) independently reached the same conclusion: IPC encoding dominates slider latency after core pipeline math was optimized. Boundary work is not a detour — it is the next Tier-1 campaign.

### 5.3 Gaps — WASM ahead on features (port candidates)

| Priority | Gap | WASM reference | Tauri today | Measured delta |
|----------|-----|----------------|-------------|----------------|
| **P0** | `jxl_lowlevel` shared decoder | `crates/raw-pipeline/src/jxl_lowlevel.rs` | `bench.rs` sketches only; not in tauri `raw-pipeline` | First-pixel vs total separation on prog assets |
| **P0** | Native `fast-jpeg` | `crates/fast-jpeg/` (`jpeg-decoder` DCT scale) | Sends raw JPEG base64 to frontend; no DCT decode | ~238 ms vs ~1748 ms decode stage (7×) |
| **P0** | `decodingSpeed` on decode | facade default `decodingSpeed: 2` | Not wired in Tauri encode/decode paths | ~30% decode win (WASM) |
| **P1** | Pyramid ingest + level ladder (M0–M4) | `pyramid-gallery-design.md` §1–§8, `encodeRgba8Pyramid` | Single full JXL + optional TJLX; no multi-level sidecar pyramid | L0 ~19 ms vs DC ~373 ms; see §11 |
| **P1** | Per-level distance sidecars (no 1.5 floor) | `bridge.cpp:EncodeRgba8WithSidecars` v2 | Uniform quality on all encode paths | 2048 level wrongly floored to ~q87 in WASM v1 |
| **P2** | True progressive refinement | `FRAME_PROGRESSION` + `FlushImage` loop | DC preview then **full** one-shot in bg task | Perceived latency on 20 MP opens |
| **P2** | `progressiveAc` / `qProgressiveAc` encode | Sneyers preset in facade | Only `progressive_dc` + `group_order` wired | Pass count / first-byte layout |
| **P2** | `encode_variants_with_progressive` in ingest | `casabio_encode.rs` | High-level path uses `encode_jxl_with_channels` | Progressive asset quality for gallery |
| **P3** | JXTC ↔ TJLX interoperability | WASM container format | TJLX only (similar semantics, different magic) | Benchmark harness mismatch |
| **P3** | Progressive region in one-shot path | C++ early crop in `oneShot` | jxl-oxide region OR tiled; progressive+region still full-then-crop in WASM too | §13 audit item |
| **P4** | `raw_decode_bench` parity harness | `src/bin/raw_decode_bench.rs` | `lightbox_bench.rs`, `strategy_bench` (different shape) | No unified Gobabeb/P2200 report |
| **P4** | Fast-path caller audit | `fast-path-principles.md` hunt list | Some paths still RGBA→RGB strip for crop encode | Extra alloc in `pipeline.rs:1125-1131` |
| **P5** | Butteraugli / encode-space tooling | web labs + benchmark scripts | No desktop equivalent | Dev tooling only |
| **P0** | **Multi-format ingest router** (ORF/DNG/CR2/JPG) | `src/lib.rs` `process_*` + pyramid spec §4 | `process_file` ORF-only; casabio misroutes DNG/CR2 through ORF TIFF path | Blocks pyramid §15 "all 5 formats" |
| **P0** | **JPG lossless transcode ingest** | `transcodeJpegToJxl` / v3 CFL path | No equivalent in Tauri `process_file` | Pyramid JPG full level |
| **P1** | **`previewFirst` decode fast path** | `jxl-decode-worker.js`, P3.3 container preview | Not wired in Tauri lightbox decode | Legacy fallback until M1 L0; see H33 |
| **P1** | **Full Sneyers encode preset** | `progressiveAc`, `qProgressiveAc`, `previewFirst` on encode | Partial (`progressive_dc`, `group_order` only) | H34; prefix-probe validates |
| **P1** | **P3.2 lightbox viewport ROI** | `computeLightboxVisibleRegion` in `main.js` | Region API exists; prefill path ignores it | H35 |
| **P2** | **`SlabPool` buffer reuse** | Opus 4.7 §3 (WASM grow-only analogue) | Not landed (`pipeline-optimisation.md` §3) | H38 |
| **P2** | **Production jxl-oxide vs jpegxl-rs pick** | N/A (WASM uses bridge) | Both in `bench.rs`; product uses jpegxl-rs only | H37 |
| **P2** | **Progressive dedup hash (R6)** | `suppress_duplicate_progress` in bridge | No native equivalent | H43 |
| **P3** | **Gallery coordinator** (multi-file progressive sync) | `jxl-progressive-gallery-coordinator.js` | None | H36; lower priority after pyramid grid |
| **P3** | **Animation seek C++ skip** | `_jxl_wasm_dec_seek_to_frame` post-rebuild | Software fallback | H44 |
| **P4** | **Prefix-probe + predator encode matrix** | `progressive-prefix-probe.mjs`, `predator-progressive-metrics.mjs` | No Tauri CLI | H41 dev harness |
| **P4** | **nosharp MT worker leak fix** | `Grok-Handoff-NoSharpMtLeak.md` | N/A (no workers) | WASM-only; informs "don't transcode+stream chain" policy |
| **P5** | **Phase 3 micro-features** (HDR signaling, JPEG recon polish, pixel-art downsampling, chunked paths) | `FEATURE_PARITY_MATRIX` §9 | Library parity ✅; Tauri high-level ingest doesn't expose | Dev/advanced encode only |
| **P5** | **icodec-jxl-worker** alternate decode | `web/icodec-jxl-worker.js` | N/A | Experimental; not product path |

### 5.4 Explicitly N/A (do not pursue parity)

| WASM feature | Reason |
|--------------|--------|
| Multi-tier WASM matrix (simd-mt, PGO) | Native libjxl + rayon supersedes (PGO/LTO still applies to Tauri — Opus 4.7 §10) |
| Emscripten `mallocAndCopy` literal | No JS heap — **but** batching/arena principle ports as H24/H25 |
| Worker scheduler preemption mid-`push()` | WASM synchronous; Tauri uses `priority_sem` + cancel between files |
| Browser native JXL `<img>` fast path | Desktop uses in-process decoder |
| OPFS-specific cache | Tauri uses filesystem directly (already faster) |
| Within-image DC progressive as primary gallery strategy | Pyramid spec supersedes for local bytes |

---

## 6. WASM Research Wins Catalog (Port Queue)

Grouped by subsystem, with primary source commit/doc.

### 6.1 RAW → RGBA pipeline (shared `raw-pipeline`)

- **Direct `process_rgba`** — fuse tone + 4ch conversion for encode (`casabio_encode.rs`). Tauri: ✅.
- **Integer exact-factor downscalers** — `downscale_rgb8_into` / `downscale_rgb16_into` (`pipeline.rs:836+`). Tauri: ✅ (synced).
- **Defer rgb16 clone until unsharp nonzero** — common path avoids copy. Verify both repos aligned.
- **Separable blur `v_pass_tiled::<128>`** — production recommendation per `rejected optimizations.md`. Audit Tauri blur paths.

### 6.2 JPEG embedded preview extraction

- **`justdecode.mjs` / IFD scanner** — selects parseable preview, skips bad Olympus markers (`35c0741`).
- **`fast-jpeg` crate** (`afee459`) — `jpeg-decoder` DCT `scale()` → RGBA; 7/7 files beat or match sharp+MT on total pipeline.
- **Tauri gap:** still emits JPEG bytes to frontend (`file_thumb_fast`); should decode natively with `fast-jpeg` (native target, ~2–3× faster than WASM).

### 6.3 JXL encode

- **Sneyers preset** — `progressiveDc=2`, `progressiveAc=1`, `qProgressiveAc=1`, `groupOrder=1` (`540f64a`, `560e2af`).
- **Per-level pyramid sidecars** — cascade `BoxDownscaleRgba8` + per-level distance (`962778f`, Plan A `sidecars_v2`).
- **JXTC tile container** — independent per-tile codestreams (`3ffbb12`, `87e2613`).
- **Tauri partial:** TJLX v2 mirrors JXTC semantics; missing pyramid sidecars and per-level distances.

### 6.4 JXL decode

- **JXTC region decode** — 9–15 ms @128 px (crop benchmark §13).
- **Pre-crop dedicated JXL** — native sim 0.5–2.1 ms @128/256 px (beats WASM JXTC).
- **`decodingSpeed: 2`** — balanced tier default (`560e2af`).
- **Opportunistic progressive flush** — bridge `TryFlushProgressiveImage` on `NEED_MORE_INPUT` (required contract; native equivalent: `FlushImage` on `FRAME_PROGRESSION`).
- **Product emit policy** — `lastPasses` + no `emitEveryPass` for local bytes (`78bce7a`, Opus4.8).
- **Bridge R4/R6** — borrowed progress snapshots, dedup-flush opt-in (`8623e93`).
- **Tauri partial:** DC preview ✅; full decode one-shot; no pass-by-pass refinement.

### 6.5 UI / perceived latency (WASM lessons applied to Tauri UI)

- **Pyramid level ladder over DC progressive** — grid seed L0 → upgrade (`pyramid-gallery-design.md` §1).
- **rAF-coalesce paints** — A2 (`1b7bc73`); relevant if Tauri frontend paints progressive frames.
- **Persistent canvases** — A3/A4 (`695be1c`); reduce per-pass alloc in web lightbox.
- **Tauri opportunity:** egui/wgpu texture upload once, patch regions on refinement (C approach deferred in WASM too).

### 6.6 Boundary / IPC discipline (Tauri-specific port queue)

Sourced from §4A inventory + Opus 4.7 strategy. **Do these before claiming parity on gallery batch ingest.**

- **H5/H3** — Thumb out of JSON integer arrays (`serialize_arc_vec_u8` → base64 or separate binary command).
- **H4** — `ProcessResult` returns `{ id, jxl_width, jxl_height, … }` without embedded `jxl` when server caches (frontend uses `decode_jxl_*_for_id`).
- **H2** — `Arc<Vec<u8>>` into bg decode; delete `(*jxl_arc).clone()`.
- **H6/H20/H27** — `file_thumb_fast`: native DCT JPEG → RGB `Response` or pre-sized canvas buffer.
- **H7** — Replace `jxl_dc_preview` base64 flood with cache marker + binary `get_jxl_lightbox` poll (same pattern as RAW `get_lightbox`).
- **H8/H26** — `pack_rgb_response` from `Arc` without memcpy when header can be prepended in reserved capacity.
- **H29** — `Channel` for `apply_look` slider stream (optional; high UX impact).

Add boundary metrics to parity harness (mirrors WASM `onMetric` + audit §7 Tier 3):

```
ipc_json_bytes_out          # serde_json size of invoke/event payload
ipc_binary_bytes_out        # Response body bytes
ipc_pack_rgb_copies         # count of pack_rgb_response allocs per session
cache_hit_jxl_id            # bool — avoided re-upload
boundary_crossings_encode   # count of encode input buffer creations per file
```

### 6.7 Measurement infrastructure

- **`raw_decode_bench`** — GOB=30, P2200=11, handoff parity summary (`HANDOFF-tauri-parity-*`).
- **`timings/fastest/bench-suite.mjs`** — 7-file fixture, sharp vs fastjpeg vs nosharp.
- **Prefix probe** — first paint byte threshold (`INCOMPLETE PLANS` prefix-probe item).
- **Tauri gap:** no single command emits the same summary JSON as `benchmark/results_native.json`.

### 6.8 Pyramid gallery — optimization levers → parity actions

The pyramid spec §10 lists twelve levers. Map to this parity program:

| Lever (spec §10) | Hack / boundary IDs | WASM status | Tauri action |
|------------------|---------------------|-------------|--------------|
| 1. One-call sidecar pyramid w/ per-level distances | **H12**, B-T6 | Plan A in flight (`sidecars_v2`) | PR-6: native `EncodeRgba8WithSidecars` v2 in `raw-pipeline` |
| 2. Cascade downscale internal (C++) | H12 | `bridge.cpp:2630-2681` | Same in native encoder; no JS cascade |
| 3. Content-addressed level files | **H28** | Plan B ingest | PR-7: `levels/{hash16}.jxl` on disk + `AppState` manifest |
| 4. `index.json` inlines aspect + L0 | H28 | Plan C | Tauri gallery: local `index.json` or in-memory grid seed from `AppState` |
| 5. One-shot decode per tile | H21 | `pyramid-pipeline.mjs` | `decode_jxl_level_for_id` — no streaming session overhead |
| 6. Monotonic level upgrades | — | Plan C client policy | Frontend: never downgrade painted tile level |
| 7. Viewport + prefetch-ring laziness | H15 | `jxl-scheduler` | Tauri: `priority_sem` + cancel offscreen decode tasks |
| 8. Scheduler dedupe by `contenthash` | **H15** | `DedupeRegistry` | Extend beyond id-only when pyramid levels land |
| 9. Right-sized level by `dimension × DPR` | H9, B-T6 | Plan C | Pick manifest level before decode; **never** full-res → downscale |
| 10. JXTC ROI for massive levels | H10 | M4 / Plan E | TJLX v2 ✅; align threshold (>40 MP top level tiled) |
| 11. Pan via canvas transform | — | Plan D1 | egui/wgpu transform; re-decode only on zoom-level change |
| 12. Bounded ingest parallelism | — | Plan B CLI | Tauri batch: `rayon` + mem-budget (`16-bit` halves budget) |

**Non-goal alignment (spec §11):** no server-side resize; no within-image DC progressive for gallery; no f32 v1; masters must fit RAM once. Tauri already satisfies "dumb static host" differently — levels live on local FS, not CDN — but **manifest schema v1** should match for Casabio push compatibility (Q2/Q7).

---

## 7. Implementation Phases

### Phase −1 — Boundary surgery (IPC & ownership) — **do first**

**Goal:** Remove Tauri-side boundary taxes that WASM already eliminated (in different form). Highest ROI per Opus 4.7 + §4A.1.

| Step | Hack IDs | Repo | Verification |
|------|----------|------|--------------|
| Thumb/base64 or binary IPC | H5, H3 | tauri | Batch ingest JSON size ↓ 3–5×; grid paint unchanged |
| Drop redundant `ProcessResult.jxl` | H4 | tauri | `process_file` response omits JXL; `jxl_cache` serves decode |
| `Arc` decode in bg prefill | H2 | tauri | No full JXL memcpy in profiling |
| Native fast-JPEG thumb | H6, H20, H27 | wasm + tauri | `file_thumb_fast` emits RGB binary; <100 ms ORF thumb |
| DC preview without base64 event | H7 | tauri | `jxl_dc_preview` → `{id, w, h}` only; pixels via `get_jxl_lightbox` |
| `pack_rgb_response` zero-copy path | H26 | tauri | `ipc_pack_rgb_copies` metric → 0 on cache hits |

**Exit criteria:** Slider `apply_look` ≤15 ms median (1800 px); batch `process_file` IPC ≤500 KB/file avg (thumb + metadata, no full JXL); bg prefill shows zero JXL `clone` in `dhat`/`heaptrack`.

### Phase 0 — Sync & measure (foundation)

**Goal:** Single source of truth for shared code; baseline numbers on both sides.

1. Merge `feat/fast-jpeg` → `tauriparity` (or rebase) to land `jxl_lowlevel.rs` + bench extensions in `raw-converter-wasm`.
2. Vendor/sync `raw-pipeline` into `raw-converter-tauri` (include `jxl_lowlevel`, `jxl-encode` feature flags).
3. Port `crates/fast-jpeg` to dual-target (`cdylib` for WASM + `rlib` for native); add `fast-jpeg-native` feature.
4. Run reference harness both sides:
   ```powershell
   # WASM repo
   $env:SKIP_INITIAL_TEST_BENCHES="1"; $env:GOB_SCAN_LIMIT=30; $env:P2200_SCAN_LIMIT=11
   .\build-msvc.ps1 run --bin raw_decode_bench --release --features jxl-lowlevel,jxl-encode

   # Tauri repo
   .\build-msvc.ps1 run --bin lightbox_bench --release   # extend to emit same metric names
   ```
5. Write results to `docs/outputs/tauri/` + update `boundary-cost-audit.md` §13.1 native columns.

**Exit criteria:** `results_native.json` schema matches; metric names identical; no compile drift between repos.

### Phase 1 — Hot-path ports (highest ROI)

**Goal:** Close the three largest per-request gaps.

| Work item | Repo | Files |
|-----------|------|-------|
| Native fast JPEG decode for `file_thumb_fast` | tauri | `pipeline.rs`, new `fast_jpeg.rs` or dep on `crates/fast-jpeg` |
| Wire `jxl_lowlevel::decode_progressive_first_total` into lightbox bg path | tauri | `pipeline.rs`, `Cargo.toml` features |
| Add `decoding_speed` to `ProcessOptions` + encoder builder | tauri | `pipeline.rs`, `casabio_encode.rs` |
| Eliminate RGBA→RGB strip on subject crop encode | tauri | `pipeline.rs:1125-1131` — encode RGBA directly |
| Wire `encode_variants_with_progressive` for full-res ingest | tauri | `casabio.rs` or `pipeline.rs` encode branch |

**Exit criteria:** Subject crop ≤3 ms; first progressive frame before full decode completes on Dc=2 assets; embedded preview decodes in <100 ms natively for ORF refs.

### Phase 2 — Pyramid gallery program (M0–M4)

**Goal:** Implement the approved pyramid gallery design on both stacks. Progressiveness = **level ladder over the wire**, not within-image DC (spec §1, §11). Depends on Phase −1 (IPC) and Phase 1 (fast-jpeg, `decodingSpeed`) for ingest throughput.

#### M0 — WASM bridge primitives (Plan A) — **WASM repo first**

| Item | Spec ref | Repo | Status |
|------|----------|------|--------|
| `encodeRgba8Pyramid` / `sidecars_v2` (per-level distances, no 1.5 floor) | §4, §12 | `packages/jxl-wasm` | In flight (`2026-06-07-pyramid-wasm-primitives.md`) |
| `BoxDownscaleRgba16` + `_jxl_wasm_downscale_rgba16` | §4, §12 | `bridge.cpp` | Plan A |
| Tauri: port same encoder to `raw-pipeline` / `casabio_encode.rs` | §4 | tauri vendor | PR-6 (after M0 WASM lands) |

**Encode contract (both stacks):**
- Levels `[256, 512, 1024, 2048]` + full (long-edge targets); skip levels ≥ master long edge.
- Distances: grid `{256,512,1024}` → **1.45** (q85); `{2048, full}` → **0.55** (q95); JPG full = lossless transcode (distance 0).
- effort = 3; orientation baked at ingest; RAW → 16-bit on `{2048, full}`, 8-bit on grid levels.
- One C++ crossing for 8-bit pyramid (was JS cascade + N encodes); RAW adds separate 16-bit calls for big levels.

#### M1 — Ingest + gallery grid (Plan B + C)

| Track | WASM (Node CLI) | Tauri (native) |
|-------|-----------------|----------------|
| Ingest trigger | On-device Node CLI batch | `process_file` + batch folder scan |
| RAW decode | `web/pkg` `process_*` (~2.5 s/image) | `memmap2` + `process_rgba` (native ahead on mmap) |
| Pyramid encode | `jxl-wasm` `encodeRgba8Pyramid` | Native sidecar encoder (PR-6) |
| Storage | `levels/{hash16}.jxl` + `images/{imageId}/manifest.json` + `index.json` | Same schema on local FS; manifest in `AppState` |
| Proxy mode | `--proxy 512` single level + `proxy: true` manifest | Optional verification-only ingest flag |
| Resumability | Skip if manifest exists + mtime unchanged | Same mtime gate |
| Grid client | Fetch `index.json` → L0 seed → DPR upgrade | Read `AppState` / local index → `decode_jxl_level_for_id` |
| Dedupe key | `contenthash` (level bytes SHA-256/16) | Same; extends H15 beyond id-only |

**Exit criteria (M1):** Ingest all 5 formats (ORF/DNG/CR2/JPG); 2048 at q95 not floored; proxy mode works; grid seeds L0 in one round-trip; monotonic crossfade upgrade; decode only near-viewport.

#### M2 — Lightbox 8-bit (Plan D1)

- Level pick: `screenLongEdge × DPR`; zoom ladder L1 → L2 → full with crossfade.
- Pan = canvas/texture transform (no re-decode until zoom level changes).
- **FilterEngine parity:** transcribe CasaBio presets/sliders into repo (`web/lightbox/filter-engine.ts` + Tauri equivalent) — external Android path is read-once docs only (spec §7).
- Live histogram; scheduler priority for current page vs prefetch (mirrors CasaBio dual dispatchers).
- WASM: reuse `jxl-scheduler` + one-shot decode; Tauri: `priority_sem` + texture LRU, binary `Response` (no base64 — Phase −1).

#### M3 — 16-bit RAW path (Plan D2)

- Toggle off by default; when on: decode 16-bit level → WebGL float adjust → Floyd-Steinberg dither → 8-bit display.
- Export retains 16-bit; requires `BoxDownscaleRgba16` + `_jxl_wasm_encode_rgba16` for ingest.
- Tauri: native 16-bit decode + wgpu float path (no COOP/COEP concern).

#### M4 — Massive scans (Plan E)

- Threshold: master long edge > ~8000 px (~40 MP) → tiled top level (JXTC WASM / TJLX native).
- Client `LevelSource`: whole-frame OR tiled ROI decode in parallel.
- Caveat: built JXTC is rgba8 only; 16-bit tiling deferred (spec §8, §12).

**Phase 2 benchmark:** port `timings/fastest/pyramid-pipeline.mjs` → `pyramid_bench.rs`; metric `decode_strategy: "pyramid-L0" | "pyramid-L1" | …`.

**Phase 2 exit criteria (aggregate):** spec §15 — see §9.5.

### Phase 3 — Progressive refinement (non-pyramid assets & lightbox polish)

**Goal:** Correct within-image progressive semantics where the pyramid ladder does **not** apply — **not** the primary gallery grid strategy (K2, spec §11).

**Scope split:**

| Use case | Strategy | Phase |
|----------|----------|-------|
| Gallery grid / tile upgrade | Pyramid level ladder (M1) | Phase 2 |
| Legacy single-JXL assets (pre-pyramid) | DC preview → pass refinement | Phase 3 |
| Lightbox on non-pyramid ingest | `jxl_lowlevel` progressive | Phase 3 |
| Diagnostic / streaming URLs | `lastPasses` policy per Opus4.8 | WASM only; optional Tauri diagnostic mode |

**Work items:**

1. Replace one-shot full bg decode with `jxl_lowlevel` state machine on `FRAME_PROGRESSION` for **non-pyramid** lightbox paths.
2. Upload passes to egui/wgpu texture (no base64 IPC — K11).
3. Encode policy on progressive assets: `progressiveDc=2`, `progressiveAc=1`, `qProgressiveAc=1`, `groupOrder=1`; **do not** paint every pass for local files (K6).
4. **Demote `jxl_dc_preview` for pyramid gallery:** after M1 lands, grid uses L0 seed; DC preview remains fallback for assets without pyramid manifest (Q4).
5. Add `time_to_first_pixel_ms` to all decode paths.

**Exit criteria:** 20 MP ORF non-pyramid asset — time-to-first-useful <200 ms; time-to-final ≤ one-shot + 10% overhead. Pyramid grid path must **not** regress to DC-first (L0 ≤25 ms native).

### Phase 4 — Container unification & ROI polish

1. Document TJLX ↔ JXTC mapping; add detection in WASM facade OR convert TJLX→JXTC at export for web parity.
2. Evaluate `JxlDecoderSetCropEnabled` when jpegxl-sys bindings expose it; else keep pre-crop assets as fast path.
3. Port crop-benchmark harness to Tauri (`strategy_bench` alignment).
4. Run predator encode matrix on native (`HANDOFF-predator-continuation` Tauri bullet).

### Phase 5 — Fast-path hunt & dev tooling

1. Apply `docs/fast-path-principles.md` heuristics to Tauri-only callers (see §5.1).
2. Optional: native encode-space explorer (lower priority than Phases 1–3).
3. Update `FEATURE_PARITY_MATRIX.md` + `INCOMPLETE PLANS.md` on each landing.

---

## 8. Key Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| K1 | **Native prefers `process_rgba`; browser prefers JS `rgb_to_rgba`** | 30-file Gobabeb measurement (`boundary-cost-audit.md` §12) |
| K2 | **Pyramid ladder replaces within-image DC progressive for gallery** | 19 ms L0 vs 373 ms DC on same asset (`pyramid-gallery-design.md`) |
| K3 | **Pre-produced small crop JXL > runtime `SetCropEnabled`** until bindings land | `jxl_lowlevel.rs` header comment; harness proves <3 ms |
| K4 | **TJLX is the native tiled container; JXTC is WASM bridge format** | Interconvert or document; don't force byte-identical parity |
| K5 | **Port `fast-jpeg` as native `rlib` first, WASM second** | Handoff: "~2–3× WASM speed" on native; eliminates transcode trap |
| K6 | **No `emitEveryPass` paint loop for local bytes in Tauri** | Opus4.8: 9.5× slowdown at 20 MP with local bytes |
| K7 | **`jxl_lowlevel` lives in `crates/raw-pipeline`; Tauri vendors it** | Avoid forked FFI state machine (`HANDOFF-continuation-2026-06-04`) |
| K8 | **Keep WASM scheduler/worker layer out of Tauri** | Different preemption model; `priority_sem` sufficient (`CLAUDE.md`) |
| K9 | **Boundary discipline ports as principles, not APIs** | `copyOrBorrowInput` → `Arc` ownership; `postMessage` transfer → `Response`; sidecar chain → native pyramid encoder |
| K10 | **Phase −1 boundary surgery before pyramid/fast-jpeg** | Opus 4.7 + B-T1..B-T9 — IPC dominates after pipeline math optimized |
| K11 | **`jxl_dc_preview` base64 is a boundary bug, not a feature** | Parallel WASM worker progressive paint tax; fix via cache + binary fetch |
| K12 | **Manifest schema v1 is shared across WASM push and Tauri local FS** | Casabio push compatibility; `levels/{hash16}.jxl` + `manifest.json` + `index.json` (spec §5) |
| K13 | **Gallery dedupe keys on `contenthash`, not `sourceKey`** | Content-addressed levels; cleaner than path-based dedupe (spec §6) |
| K14 | **RAW decode once at ingest; per-view never touches RAW** | ~2.5 s/image cost center; pyramid amortizes across all levels (spec §2) |
| K15 | **Phase 3 progressive ≠ Phase 2 pyramid** | Within-image passes for legacy assets only; gallery uses level ladder (spec §11) |
| K16 | **`process_file` must route by format before pyramid ingest** | Tauri ORF-only path + casabio misroute blocks spec §15 five-format criterion (H31) |
| K17 | **M0 code must land before claiming pyramid parity** | `sidecars_v2` / `downscaleRgba16` are doc-only until `exports.txt` + bridge land (H40) |
| K18 | **Do not copy web `emitEveryPass` paint to Tauri local bytes** | Opus4.8 9.5× at 20 MP; gallery uses L0 ladder instead (H42) |

---

## 9. Verification Plan

### 9.1 Reference datasets

| Dataset | Env vars | Purpose |
|---------|----------|---------|
| Gobabeb 30 ORF | `GOB_SCAN_LIMIT=30`, `GOB_ROOT` | Encode parity |
| P2200 11 ORF | `P2200_SCAN_LIMIT=11`, `P2200_ROOT` | Decode / ROI |
| 7-file fast-jpeg fixture | `timings/fastest/bench-suite.mjs` | JPEG → RGBA → JXL |
| Pyramid ORF | `P2200476` | Level ladder timings |

### 9.2 Metric contract (both sides must emit)

```
decode_buffer_extract_ms
decode_region_downsample_ms
source_pixels_decoded
time_to_first_pixel_ms
decode_strategy          # "full" | "pre-crop" | "tiled" | "jxtc" | "pyramid-L0" | ...
encode_direct_rgba_ms
queue_wait_ms / scheduler_queue_wait_ms
```

### 9.3 Targets (from existing measurements)

| Scenario | WASM best | Native target |
|----------|-----------|---------------|
| Small crop @128 px | 9–15 ms (JXTC) | ≤3 ms (pre-crop; already 0.5–1 ms in sim) |
| Full decode 20 MP | ~2.5–2.9 s | ≤2.5 s (compute-bound; win on extract=0) |
| `decode_buffer_extract` | ~3.8 ms avg | ~0 ms |
| Embedded preview → RGBA | ~1748 ms (nosharp) / ~238 ms (fastjpeg) | ≤120 ms native fast-jpeg |
| Grid L0 seed | ~19 ms (pyramid) | ≤25 ms native pyramid |
| Encode direct-rgba prep | ~65 ms JS-path (WASM) | ≤350 ms (full tone; native includes real work) |

### 9.4 Regression gates

- `cargo check` / `build-msvc.ps1 check` on both repos after each PR.
- `raw-pipeline` tests: 21+ pipeline tests pass in tauri vendored copy.
- Progressive contract tests if touching decode loop:
  ```powershell
  rtk proxy bun test packages/jxl-wasm/test/progressive-visible-passes.test.ts
  ```
  (WASM-side guard; native tests to be added mirroring `jxl_lowlevel` behavior.)

### 9.5 Pyramid gallery success criteria (from spec §15)

Both stacks must satisfy these when Phase 2 completes:

| Criterion | WASM verification | Tauri verification |
|-----------|-------------------|-------------------|
| Ingest pyramid + manifest for ORF/DNG/CR2/JPG | Plan B CLI + spec §14 fixtures | `process_file` batch on same fixtures |
| Per-level distance: 2048 at q95, not floored to 1.5 | `pyramid-bridge-runtime.test.ts` + ingest unit | Native encoder distance assert |
| JPG full = lossless transcode | Bit-exact vs source decode | `transcode_jpeg_to_jxl` path |
| Proxy mode: single level, `proxy: true` | `--proxy 512` CLI | Optional ingest flag |
| Grid: L0 seed one round-trip, DPR upgrade, monotonic | Plan C client tests | Gallery UI + `decode_jxl_level_for_id` |
| Lightbox: zoom ladder, pan, FilterEngine parity | Plan D1 tests | egui lightbox + filter unit tests |
| 16-bit toggle: visible highlight/shadow recovery on RAW | Plan D2 WebGL path | wgpu float path |
| ROI crop export | `decodeRegionLod` / JXTC ROI | `decode_jxl_subject_crop_for_id` / TJLX ROI |
| Massive scan (>40 MP): tiled top + parallel ROI | Plan E + M4 | TJLX threshold at ingest |
| No server-side image logic; immutable content-addressed bytes | Static CDN layout §5 | Local `levels/{hash16}.jxl` |
| Pure-WASM ingest (no `sharp`) | Plan B constraint | N/A — native is already pure Rust |

---

## 10. PR Plan

Ordered stack; each PR independently reviewable.

| PR | Title | Repo | Depends | Files / scope |
|----|-------|------|---------|---------------|
| PR-0a | `perf(tauri): binary/base64 thumb; drop JSON u8 array in ProcessResult` | tauri | — | `pipeline.rs` `serialize_arc_vec_u8`, frontend thumb paint |
| PR-0b | `perf(tauri): ProcessResult id-only JXL; omit redundant jxl base64` | tauri | PR-0a | `ProcessResult`, `jxl_cache` contract, frontend |
| PR-0c | `perf(tauri): Arc JXL decode in bg prefill; fix pack_rgb copies` | tauri | — | `pipeline.rs:1264+`, `pack_rgb_response` |
| PR-0d | `perf(tauri): file_thumb_fast native JPEG DCT + binary RGB` | wasm + tauri | — | `fast-jpeg` rlib, `pipeline.rs:904+` |
| PR-0e | `perf(tauri): DC preview cache handshake (no base64 event)` | tauri | PR-0c | `jxl_dc_preview`, `get_jxl_lightbox` |
| PR-0f | `feat(tauri): multi-format ingest router ORF/DNG/CR2/JPG` | tauri | — | H31/H32; fix casabio `decode_raw_to_rgba`; pyramid §4 blocker |
| PR-1 | `sync(raw-pipeline): land jxl_lowlevel from feat/fast-jpeg` | wasm → tauri vendor | PR-0c | `jxl_lowlevel.rs`, `Cargo.toml` features, `lib.rs` |
| PR-2 | `feat(fast-jpeg): dual-target native rlib + Tauri file_thumb_fast decode` | wasm + tauri | PR-1 | `crates/fast-jpeg/`, `pipeline.rs` |
| PR-3 | `feat(tauri): wire jxl_lowlevel progressive into lightbox prefill` | tauri | PR-1 | `pipeline.rs`, replace one-shot bg full |
| PR-4 | `feat(tauri): decodingSpeed + full Sneyers encode preset` | tauri | PR-1 | `ProcessOptions`, `encode_jxl_with_channels` |
| PR-5 | `perf(tauri): encode subject crops as RGBA; drop rgb strip` | tauri | — | `pipeline.rs:1120-1150` |
| PR-6 | `feat(jxl-wasm): Plan A M0 — sidecars_v2 + downscaleRgba16` | wasm | — | `bridge.cpp`, `facade.ts`, `pyramid-bridge*.test.ts` |
| PR-6b | `feat(raw-pipeline): native pyramid sidecar encoder` | wasm + tauri | PR-6 | port `EncodeRgba8WithSidecars` v2 to Rust |
| PR-7 | `feat(pyramid): Plan B ingest CLI + manifest/index` | wasm | PR-6 | Node CLI, content-addressed `levels/`, proxy mode |
| PR-7b | `feat(tauri): pyramid ingest + manifest cache at process_file` | tauri | PR-6b | `pipeline.rs`, `AppState`, storage layout §5 |
| PR-8 | `feat(pyramid): Plan C gallery grid (index seed + monotonic upgrade)` | wasm | PR-7 | `web/` grid client, scheduler `contenthash` dedupe |
| PR-8b | `feat(tauri): gallery level picker (L0 seed + viewport upgrade)` | tauri | PR-7b | frontend + `decode_jxl_level_for_id` command |
| PR-9 | `feat(pyramid): Plan D1 lightbox 8-bit + FilterEngine` | wasm + tauri | PR-8 | `filter-engine.ts`, zoom ladder, histogram |
| PR-9b | `feat(pyramid): Plan D2 16-bit WebGL toggle + ROI export` | wasm | PR-9 | decode16 → adjust → FS dither |
| PR-10 | `feat(pyramid): Plan E JXTC massive-scan threshold` | wasm + tauri | PR-7 | >40 MP tiled top level; ROI parallel decode |
| PR-11 | `bench: unify raw_decode_bench + lightbox_bench + pyramid_bench` | wasm + tauri | PR-3 | metric schema, spec §15 gates |
| PR-12 | `docs: update parity matrix + audit native columns` | wasm | PR-11 | `FEATURE_PARITY_MATRIX.md`, `boundary-cost-audit.md`, `INCOMPLETE PLANS.md` |

---

## 11. Open Questions

| # | Question | Options | Default if no answer |
|---|----------|---------|---------------------|
| Q1 | Merge strategy for long-lived branches | `feat/fast-jpeg` → `main` → tauri vendor vs direct cherry-pick | Rebase `jxl_lowlevel` onto `main` first |
| Q2 | Pyramid storage in Tauri | Local manifest only vs Casabio push-compatible layout | **Casabio-push-compatible layout** on local FS — same schema v1 as spec §5; push = copy `levels/` + manifests |
| Q3 | TJLX vs JXTC on web export | Convert at push time vs maintain two formats | Document + convert on web push |
| Q4 | Keep DC preview after pyramid lands? | Retain as fallback vs remove | **Retain for non-pyramid assets only**; gallery grid uses L0 seed (K2, K15) |
| Q5 | `fast-jpeg` vs libjpeg-turbo for native | Pure Rust `jpeg-decoder` vs turbojpeg-sys | `jpeg-decoder` first (no new C dep); turbojpeg if CR2 gap matters |
| Q6 | Thumb delivery shape | base64 in JSON vs separate `get_thumb(id)` binary `Response` | Separate binary command (matches `get_lightbox` pattern) |
| Q7 | Drop `ProcessResult.jxl` entirely? | Yes (id-only) vs keep for Casabio push/export | **id-only for gallery**; pyramid levels in `levels/`; optional `include_jxl` for legacy export |
| Q8 | Tauri ingest: inline pyramid vs background job | Pyramid in `process_file` sync vs `spawn_blocking` batch | Background for batch; sync pyramid only if ≤512 proxy needed for instant grid |
| Q9 | FilterEngine port location in Tauri | Shared `raw-pipeline` vs frontend-only TS | TS `filter-engine.ts` for web; Rust mirror for native wgpu if needed — single source of matrix math with unit tests |

---

## 12. Pyramid Gallery Program — Integrated View

This section folds `2026-06-07-pyramid-gallery-design.md` into the parity program. The pyramid spec is **authoritative** for gallery/lightbox architecture; this section maps it to WASM vs Tauri execution.

### 12.1 Core thesis

```
Progressiveness = resolution level ladder over the wire
NOT within-image DC progressive (for gallery)

Benchmark anchor: DC preview ~373 ms  vs  pyramid L0 256px ~19 ms (same asset, local bytes)
```

RAW decode (~2.5 s/image) is the cost center. It runs **once at ingest**; every grid tile, lightbox zoom step, and adjustment preview reads prebuilt JXL levels — never the RAW master.

### 12.2 Topology — WASM hybrid vs Tauri on-device

```
WASM (spec §2):
  [Node CLI ingest]  →push→  [static/CDN]  →get→  [browser + jxl-wasm]

Tauri (parity mapping):
  [process_file / batch scan]  →write→  [local FS levels/ + manifest]  →read→  [egui/wgpu + native decode]
```

| Layer | WASM | Tauri parallel |
|-------|------|----------------|
| Ingest | Node CLI; `web/pkg` + `jxl-wasm` | `process_file`; `memmap2` + native encoder (no WASM heap) |
| Storage | `levels/{hash16}.jxl`, `images/{id}/manifest.json`, `index.json` | Same schema on disk; hot manifest in `AppState` |
| Transport | HTTP/2 + `Cache-Control: immutable` | Direct FS read (faster; no IPC for level bytes if decoded in-process) |
| Client decode | One-shot `_jxl_wasm_decode_rgba8` via scheduler | `decode_jxl_level_for_id` → `Response` binary |
| Dedupe | Scheduler by `contenthash` | Extend `jxl_cache` + level cache by `contenthash` (H15) |
| Server logic | **Zero** (dumb static) | **Zero** (no transform endpoint) |

### 12.3 Milestone map — WASM vs Tauri

| Ms | Scope | WASM deliverable | Tauri deliverable | Parity phase |
|----|-------|------------------|-------------------|--------------|
| **M0** | Bridge primitives | Plan A: `sidecars_v2`, `downscaleRgba16` | Vendor native encoder after PR-6b | Phase 2 (first) |
| **M1** | Ingest + grid | Plan B CLI + Plan C web grid | `process_file` pyramid + local index + gallery UI | Phase 2 |
| **M2** | Lightbox 8-bit | Plan D1: zoom ladder, FilterEngine, histogram | egui lightbox + filter parity | Phase 2 |
| **M3** | 16-bit RAW | Plan D2: WebGL float + FS dither | wgpu float path + native decode16 | Phase 2 |
| **M4** | Massive scans | Plan E: JXTC tiled top + ROI | TJLX threshold + parallel ROI (H10 ✅) | Phase 2 + Phase 4 |

Each milestone is independently shippable (spec Milestones table). Tauri can land M0+M1 before WASM Plan C if native encoder + `AppState` manifest are ready — desktop has no CDN round-trip advantage on ingest, but wins on decode IPC (binary `Response`, no worker transfer).

### 12.4 Ingest contract (both stacks)

**Inputs:** ORF, DNG, CR2, JPG.

| Input | Full level | Grid levels | Big levels |
|-------|------------|-------------|------------|
| JPG | Lossless `transcodeJpegToJxl` (8-bit) | 8-bit sidecars q85 (1.45) | N/A (all 8-bit) |
| RAW | 16-bit q95 (0.55) | 8-bit sidecars q85 | 16-bit `{2048, full}` |

**Pyramid sizes:** `[256, 512, 1024, 2048]` + full — long-edge targets; skip upscaling.

**Quality mapping:** `distance = 0.1 + (100 − q) × 0.09`; sidecar v2 removes 1.5 floor that wrongly clamped 2048.

**JXTC threshold:** long edge > ~8000 px → tiled top level (rgba8 v1; 16-bit tiling deferred).

**Proxy mode:** `--proxy <256|512|1024>` default 512 — single verification level, no full pyramid, no push.

### 12.5 Client contracts

**Gallery grid (spec §6):**
1. Seed from `index.json` L0 inline (one round-trip layout + first bytes).
2. Upgrade to level matching `tileSize × devicePixelRatio`.
3. Monotonic — never downgrade a painted tile.
4. Lazy viewport + prefetch ring; cancel offscreen via scheduler / `priority_sem`.
5. One-shot decode per tile (not streaming session — ~15–20 ms overhead avoided).

**Lightbox (spec §7):**
- CasaBio interaction model (zoom %, dual-priority prefetch, screen-bitmap LRU).
- FilterEngine presets + sliders with live color-matrix preview.
- 16-bit toggle (RAW only): real highlight/shadow headroom vs clipped 8-bit path.
- ROI crop export via region decode.
- **Not porting:** annotations, video, taxonomy, messaging.

### 12.6 What changes in existing parity items

| Prior parity item | After pyramid incorporation |
|-------------------|----------------------------|
| `jxl_dc_preview` as grid first paint (H7) | **Demoted** — L0 seed replaces DC for gallery (K2, Q4) |
| Full decode → downscale lightbox (B-T6) | **Eliminated** — pick manifest level before decode (H9) |
| Single full JXL in `jxl_cache` | **Extended** — level cache keyed by `contenthash` + manifest |
| Phase 3 progressive refinement | **Scoped** to non-pyramid / legacy assets only (K15) |
| `encode_variants_with_progressive` ingest | Still relevant for **progressive asset quality** on full level, not grid strategy |
| Subject pre-crop JXL (H11) | Complements M4 ROI; distinct from pyramid grid levels |

### 12.7 Build dependencies cross-walk

| Dependency | WASM | Tauri |
|------------|------|-------|
| RAW pipeline | `web/pkg` rebuild if `src/lib.rs` changes | Vendored `raw-pipeline` sync |
| Sidecar v2 | `bridge.cpp` + Emscripten rebuild | Native Rust port (PR-6b) |
| 16-bit downscale | `BoxDownscaleRgba16` (Plan A) | Same in `raw-pipeline` |
| 16-bit JXTC | Deferred (no rgba16 tile export) | TJLX rgba8 only today |
| COOP/COEP | Required for MT WASM | N/A — `rayon` native threads |
| CasaBio FilterEngine | Transcribe to `filter-engine.ts` | Rust/wgpu mirror or shared WASM module in webview |

### 12.8 Reuse of existing 5/5 pipeline (spec §9)

WASM reuses `jxl-scheduler`, `pool`, `jxl-worker`, `jxl-cache`, `jxl-stream`, `facade` — no new backpressure/dedupe layers (CLAUDE.md invariants). Tauri reuses `priority_sem`, `jxl_cache`, `subject_jxl_cache`, binary `Response` pattern — **does not** port worker scheduler (K8).

---

## 13. WASM Integration Sweep — Remaining Work (2026-06-07)

Second pass over `feat/fast-jpeg`, `FEATURE_PARITY_MATRIX.md`, `INCOMPLETE PLANS.md`, facade exports, `web/`, and live `raw-converter-tauri` code. Items below are **not yet integrated** into Tauri (or not yet **coded** on WASM). Cross-ref §4A H31–H44.

### 13.1 Blockers — pyramid spec §15 cannot pass without these

| Item | WASM today | Tauri today | Action |
|------|------------|-------------|--------|
| Plan A M0 (`sidecars_v2`, `downscaleRgba16`) | Plan doc only; symbols **absent** from `exports.txt` | Waiting on WASM + native port | PR-6 then PR-6b |
| Plan B ingest CLI | Not written | N/A | Node CLI after M0 |
| Plan C/D/E client | Not written | N/A | Grid, lightbox, JXTC threshold |
| **CR2 ingest** | `process_cr2` / `cr2::decode_bytes` in `src/lib.rs` | `strategy_bench` only; **not** `process_file` | H31 |
| **DNG ingest** | `process_dng` / `dng::decode_bytes` | Misrouted through ORF `tiff::parse` in casabio | H31 |
| **JPG ingest** | `transcodeJpegToJxl` → lossless full level | JPEG classified in casabio but no transcode path | H32 |

**Critical bug-shaped gap:** `casabio::decode_raw_to_rgba` and `pipeline::process_file` both assume Olympus ORF TIFF strips. Files classified as `SourceType::Raw` (DNG, CR2, …) will fail or produce garbage until a format router lands.

### 13.2 Tier 1 — high ROI (measured or boundary-proven)

Already in phase plan but confirmed still open on both repos:

| Feature | WASM evidence | Tauri gap | Hack |
|---------|---------------|-----------|------|
| `jxl_lowlevel` in vendored `raw-pipeline` | `crates/raw-pipeline/src/jxl_lowlevel.rs` on `feat/fast-jpeg` | Not synced to tauri vendor | P0, PR-1 |
| Native `fast-jpeg` rlib | `crates/fast-jpeg/` 7/7 bench wins | `file_thumb_fast` emits JPEG base64 | H6/H20, PR-0d/PR-2 |
| `decodingSpeed: 2` decode + encode | Facade default; `exports.txt` wired | **Zero** `decoding_speed` in tauri `pipeline.rs` | H22, PR-4 |
| Full Sneyers encode | `progressiveAc=1`, `qProgressiveAc=1`, `previewFirst` | `progressive_dc` + `group_order` only | H34 |
| Phase −1 IPC surgery | N/A | B-T1..B-T9 all open | PR-0a..0e |
| Pyramid M1+ | `timings/fastest/pyramid-pipeline.mjs` (exploratory) | No manifest / level cache | §12, PR-7..8b |

### 13.3 Tier 2 — decode / paint paths (web landed, Tauri partial)

| WASM feature | Site | Tauri status | Integrate as |
|--------------|------|--------------|--------------|
| Pyramid L0 one-shot grid seed | `pyramid-pipeline.mjs`, spec §6 | Not implemented | M1; replaces DC-first gallery (K2) |
| `previewFirst` + container JPEG recon | `jxl-decode-worker.js:83+`, `extractJpegReconstructionFromJxl` | Missing | H33 legacy fallback |
| Viewport ROI re-decode on zoom/pan | P3.2 `computeLightboxVisibleRegion` | `decode_jxl_region_for_id` exists; prefill ignores ROI | H35 |
| `applyRegionAndDownsample` before IPC | `facade.ts:2235+` | Full decode → `downscale_rgb8` in bg task | B-T6 / H9 |
| `decodeRegionLod` / `decodeViewport` | `facade.ts:1024+` | Bench/jxl-oxide only | Fold into level picker (H39) |
| Progressive pass dedup (R6) | `bridge.cpp` `suppress_duplicate_progress` | No hash gate on texture upload | H43 |
| Product emit policy (no `emitEveryPass` local) | `78bce7a`, Opus4.8 | Risk if copying web progressive paint | H42 / K6 |
| `jxl_lowlevel` progressive emit | `decode_progressive_first_total` | DC preview + one-shot full bg | Phase 3, K15 |

### 13.4 Tier 3 — encode / ingest infrastructure

| WASM feature | Tauri port |
|--------------|------------|
| Per-level distance sidecar v2 | PR-6/6b (blocked on M0 code) |
| 16-bit `{2048, full}` pyramid levels | Requires `BoxDownscaleRgba16` + native `encode_rgba16` |
| JXTC tiled top (>40 MP) | WASM Plan E; Tauri TJLX v2 ✅ — align threshold + ROI API |
| `encode_variants_with_progressive` at ingest | Exists in `casabio_encode.rs` WASM repo; Tauri uses `encode_jxl_with_channels` without full variant ladder |
| Bounded ingest parallelism (mem-aware) | Tauri: `rayon` + 16-bit halved budget (spec §4) |
| Proxy ingest mode (`--proxy 512`) | Not on either product path yet |

### 13.5 Tier 4 — web UX / gallery (Plans C/D — not started)

| WASM module | Port target |
|-------------|-------------|
| `index.json` grid seed + monotonic upgrade | Tauri `AppState` + gallery UI |
| `jxl-progressive-gallery-coordinator.js` | Optional; pyramid grid supersedes for stills (H36) |
| `filter-engine.ts` (Plan D) | Transcribe from CasaBio; unit tests in-repo |
| 16-bit WebGL toggle + FS dither | Tauri wgpu float path (M3) |
| rAF paint coalesce (A2) | Only if retaining within-image progressive paint |
| `Channel` streaming `apply_look` | Opus 4.7 Fix C (H29) |

### 13.6 Tier 5 — dev tooling / WASM-only (inform policy, don't port literally)

| Item | Note |
|------|------|
| `computeButteraugli` / encode-space explorer | Dev labs only (P5) |
| `progressive-prefix-probe.mjs` | Port to native bench for encode tuning (H41) |
| Multi-tier WASM (simd-mt, PGO) | N/A; native LTO/PGO per Opus 4.7 §10 |
| nosharp MT worker leak | WASM fix only (`Grok-Handoff-NoSharpMtLeak.md`) |
| OPFS cache | Tauri FS already faster |
| COOP/COEP / worker tier matrix | N/A native |
| Animation seek C++ skip | Post-rebuild polish (H44) |
| Phase 3 micro-features (§9 matrix) | Library ✅; ingest doesn't need all knobs |

### 13.7 Suggested integration order (updated)

```
Phase −1  IPC (H5,H4,H2,H6,H7,H26)     ← still #1 ROI
Phase 0   Sync jxl_lowlevel + measure
Phase 0b  H31/H32 format router        ← NEW: before pyramid ingest claims 5 formats
Phase 1   fast-jpeg + decodingSpeed + Sneyers full (H22,H34)
Phase 2   M0→M4 pyramid program
Phase 3   Legacy progressive only (K15,H42,H43) — NOT gallery grid
```

### 13.8 WASM in-flight on `feat/fast-jpeg` not yet in product paths

| Change | Status |
|--------|--------|
| `crates/fast-jpeg` WASM crate | ✅ coded; Tauri rlib not started |
| `jxl_lowlevel.rs` + bench extensions | ✅ coded; not vendored to Tauri |
| Opus4.8 single-progressive emit policy | ✅ WASM web; policy doc for Tauri (H42) |
| Bridge R4/R6 progressive snapshot/dedup | ✅ WASM; native port pending (H13/H43) |
| Plan A pyramid primitives | 📄 doc only — **no code in bridge yet** |
| Node MT sync deadlock fix (`aa99ebe`) | ✅ WASM only |

---

## 14. References

- `docs/HANDOFF-tauri-parity-2026-06-03.md`
- `docs/HANDOFF-tauri-parity-continuation-2026-06-04.md`
- `docs/boundary-cost-audit.md`
- `docs/fast-path-principles.md`
- `docs/FEATURE_PARITY_MATRIX.md`
- `docs/suggested-settings.md` — "Native / Tauri Preferences"
- `docs/Grok-Handoff-FastJpeg.md`
- `docs/superpowers/specs/2026-06-07-pyramid-gallery-design.md`
- `docs/superpowers/plans/2026-06-07-pyramid-wasm-primitives.md`
- `docs/Opus4.8ThrottleFindings.md`
- `docs/rejected optimizations.md`
- `crates/raw-pipeline/src/jxl_lowlevel.rs`
- `C:\Foo\raw-converter-tauri\src-tauri\src\pipeline.rs`
- `timings/fastest/` — empirical pipeline scripts
- `C:\Foo\raw-converter-tauri\docs\Claudes Opus 4.7 Improvement Strategy.md` — IPC-first Tauri optimization roadmap (binary Response, buffer pool, rayon)
- `C:\Foo\raw-converter-tauri\docs\superpowers\plans\2026-06-02-pipeline-optimisation.md` — §1 binary IPC task spec (partially landed)

### Code anchors (boundary hacks)

WASM direct decode buffer (ownership transfer, no memcpy):

```447:449:packages/jxl-wasm/src/bridge.cpp
      // Direct-buffer decode: libjxl writes pixels straight into pixels_raw — no intermediate
      // copy. Result is returned via MakeBufferFromOwned (ownership transfer, no memcpy).
      if (JxlDecoderSetImageOutBuffer(dec, &pf, pixels_raw, pixels_size) != JXL_DEC_SUCCESS) { free(pixels_raw); JxlDecoderDestroy(dec); return MakeError(12); }
```

WASM ownership-safe chunk transfer:

```2229:2233:packages/jxl-wasm/src/facade.ts
// Borrow or copy input depending on caller's ownership. ArrayBuffer is always zero-copy (view only).
function copyOrBorrowInput(value: ArrayBuffer | Uint8Array, copy: boolean): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return copy ? value.slice() : value;
}
```

Tauri binary IPC (landed) vs thumb JSON (still open):

```10:15:C:\Foo\raw-converter-tauri\src-tauri\src\pipeline.rs
fn pack_rgb_response(data: &[u8], width: usize, height: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + data.len());
    out.extend_from_slice(&(width as u16).to_le_bytes());
    out.extend_from_slice(&(height as u16).to_le_bytes());
    out.extend_from_slice(data);
    out
}
```

```144:149:C:\Foo\raw-converter-tauri\src-tauri\src\pipeline.rs
fn serialize_arc_vec_u8<S>(v: &std::sync::Arc<Vec<u8>>, ser: S) -> Result<S::Ok, S::Error>
where S: serde::Serializer {
    use serde::ser::SerializeSeq;
    let mut seq = ser.serialize_seq(Some(v.len()))?;
    for b in v.iter() { seq.serialize_element(b)?; }
```

Tauri bg prefill full JXL clone (fix target):

```1264:1272:C:\Foo\raw-converter-tauri\src-tauri\src\pipeline.rs
    if let Some(jxl_arc) = jxl_for_prefill {
        let jxl_bytes = (*jxl_arc).clone();
        let id = _id;
        ...
        tokio::task::spawn_blocking(move || {
            ...
            if let Ok((rgb, w, h)) = decode_jxl_full_inner(jxl_bytes) {
```

---

*This document is the canonical parity program spec. Update it when a phase lands or when new WASM research changes the port queue. Rev 5 triages Gemini §1 progressive lessons (scope vs pyramid/K6, fix numbering). Rev 4 adds §13 integration sweep. Rev 3 pyramid gallery. Rev 2 boundary inventory (§4A).*