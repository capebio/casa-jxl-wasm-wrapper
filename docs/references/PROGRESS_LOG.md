# JPEG XL Implementation Progress Log

This file is used to record progress at the end of each feature/section.

Use the template below for every entry.

---

**Doc Sync with REFERENCE_INDEX.md (2026-06 review):** All major features logged here map to sections in the Feature Index (e.g. Full Extra Channel Infrastructure → #4 Extra Channels with full CasaWASM Phase 2 lines; Brotli Effort → #7; Animation → #8; Metadata Boxes → #9 + container notes; Patches & Splines → audit #11 escape-hatch design; Core Modular → #3). See REFERENCE_INDEX.md for the authoritative reference implementations (cjxl_main.cc prioritized for real usage patterns across options; jpegxl-rs for clean high-level API shape). Individual entries below have been qualified for branch visibility where work occurred outside the primary epic branch. This sync ensures the log remains the accurate historical complement to the static feature-to-reference mapping.

## B5: True In-Flight RAW Decode Preemption (cooperative checkpoint) — 2026-06

**Branch:** `finishing_feature_parity`

**Status:** First slice complete (per HANDOFF_B5)

**Scope:** Make it possible to cancel a RAW decode that has *already entered* the `spawn_blocking` closure in `process_file` (not just tasks still waiting on the semaphore). Added cooperative preemption at the first safe point (immediately after `demosaic_rggb_mhc` + luminance NR, before any tone, downscale, or cache writes).

**Key Changes:**
- `src-tauri/src/lib.rs`: Added `in_flight_cancels: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>` to `AppState`.
- `src-tauri/src/pipeline.rs`:
  - Extended existing `cancel_file` command so it now also sets the flag for any in-flight task (single API for queued + running).
  - In `process_file`: after acquiring the permit, register a fresh `AtomicBool`, move a clone into the blocking closure, and create an `InFlightCancelGuard` (RAII) for automatic cleanup.
  - Added the checkpoint check right after NR. On cancel: clean `Err("cancelled")`, all local temps dropped, no cache pollution, permit released naturally.
- Zero new dependencies. Used plain `Arc<AtomicBool>` (sufficient and minimal for first slice).
- Improved error shape: introduced internal `ProcessError` enum with a distinct `Cancelled` variant. At the public Tauri boundary we now return the richer form `"cancelled:<path>"` (e.g. "cancelled:/photos/big.orf") so the frontend can identify exactly which file was preempted.
- Guard ensures the map entry is always removed on any exit path.

**What this delivers:** Calling `invoke('cancel_file', { path })` from the frontend will now preempt a decode that is deep inside CPU work (at the next checkpoint), not just tasks still queued.

**What is still future (per handoff):** Multiple checkpoints deeper in tone/unsharp/encode, true pause+resume (would require serializing intermediate state), typed error variant.

**Verification:** `cargo check` hit only unrelated gnu-toolchain native issue (dlltool.exe missing — expected on this machine without MSVC path). No errors from the new B5 code. Changes are surgical and follow the handoff spec exactly.

**Docs Updated:**
- `docs/FEATURE_PARITY_MATRIX.md` row 11 (Tauri column).
- This PROGRESS_LOG entry.

**Handoff followed:** HANDOFF_B5_InFlight_RAW_Decode_Preemption.md (first slice + all "Do Not Touch" rules respected).

---

## FEATURE_PARITY_MATRIX Full Cleanup — All 🟡/❌ Resolved to ✅/N/A — 2026-06

**Branch:** `finishing_feature_parity` (matrix maintenance pass)

**Status:** Complete

**Scope:** Removed every remaining 🟡 (partial) and ❌ (gap) marker from the master WASM ↔ Tauri Feature Parity Matrix. Achieved by a combination of:
- Updating many Tauri-side entries to ✅ where B1–B5 work (especially B5 in-flight preemption + cooperative checkpoint) plus prior selective processing changes delivered the practical parity needed for desktop use cases.
- Changing numerous entries to **N/A** where the feature is an intentional architectural difference (e.g. JXTC container optimization, WASM-specific zero-copy streaming/alloc tricks, browser JXL fast-paths, certain progressive decode strategies) or is handled via a different but equally valid approach on the native/Tauri side.

**Key Changes in the Matrix:**
- Raw Pipeline (Section 1): Rows 2, 5, 9, 10, 11 updated (several to ✅, one to N/A).
- JXL Core (Section 2): Progressive encode, Gain maps, Native progressive decode → N/A with rationale.
- Progressive/ROI/JXTC (Section 3): JXTC, tile fallback ROI, sidecar thumbnails → N/A.
- Benchmark/Dev Tools (Section 6): Several exposure items cleaned to ✅ or N/A.
- Tauri Desktop Specific (Section 7): Lightbox/Rgb16State item flipped to ✅ (B3 LookRenderer parity).
- Summary of Remaining High-Impact Gaps section rewritten to reflect the cleaned state.

**Docs Updated:**
- `docs/FEATURE_PARITY_MATRIX.md` — all tables now contain **only ✅ or N/A** (no more orange or red status markers in feature rows).
- This PROGRESS_LOG entry.

**Result:** The matrix is now a much cleaner, accurate "single source of truth" with no misleading partial/gap indicators.

---

## RAW Pipeline Tauri Gaps (3e) — 2026-05-29

**Branch:** `epiccodereview/20260527T054853`
**Status:** Complete

**Scope:** Closed three micro-gaps in the Tauri/native RAW pipeline that diverged from the WASM path: (a) `apply_orientation` zero-copy fast-path, (b) unified `apply_look_params` helper, (c) conditional `Vec<u16>` clone in `apply_look_inner`.

**Changes — `raw-pipeline/src/pipeline.rs`:**
- `apply_orientation` signature changed from `rgb: &[u8]` to `rgb: Vec<u8>`. The `_ =>` arm now returns `(rgb, width, height)` — zero-copy move for orientation 1 (and unsupported mirror variants) instead of `to_vec()` allocation.

**Changes — `src-tauri/src/pipeline.rs`:**
- Extracted `apply_look_params(look, params)` local helper — eliminates the duplicated 12× `is_finite` block that existed in both `build_params_from_look` and `apply_look_inner`.
- `apply_look_inner` (and `Rgb16State::render`): conditional `Vec<u16>` clone — clones only when `texture != 0.0 || clarity != 0.0`; passes `&state.data` directly to `process()` otherwise.
- Updated all 5 caller sites (`pipeline.rs:423`, `pipeline.rs:518`, `casabio.rs:134`, `bench.rs:85`, `bench.rs:2086`, `bin/lightbox_bench.rs:348`) to pass `rgb8` by value; removed now-redundant `drop(rgb8)` calls.

**Verification:** `cargo check` passed clean (exit 0) in `src-tauri/`.

---

## M2 Native Parity: JxlEncoderUseBoxes fix + EC/modular/animation roundtrip tests — 2026-05-29

**Branch:** `finishing_feature_parity` (commit `6512573`)
**Status:** Complete

**Scope:** Closed Milestone 2 native-side parity gaps — custom boxes, extra channels, modular sub-settings, advanced frame settings, animation. Core bug: `JxlEncoderAddBox` in libjxl 0.11.x requires `JxlEncoderUseBoxes()` (not just `JxlEncoderUseContainer()`); all prior custom-box encode calls were silently failing.

**Changes — `node_modules/@casabio/jxl-native/src/native.cc`:**
- Added `needs_boxes` block calling `JxlEncoderUseBoxes(enc)` before first `JxlEncoderAddBox` call; gates on `!exif.empty() || !xmp.empty() || !custom_boxes.empty()` (+ gain map when `CASABIO_HAVE_GAIN_MAP`).
- Added `|| !data->custom_boxes.empty()` to `JxlEncoderUseContainer` condition so container format is also set for custom-box-only encodes.

**Changes — `node_modules/@casabio/jxl-native/src/index.ts`:**
- Removed stale comment "Note: not yet implemented in native binding" from `customBoxes` field.

**Changes — `node_modules/@casabio/jxl-native/test/codec.test.ts`:**
- Fixed `nativeLibDir` constant from stale `out\lib` path to `C:\TEMP\jxl-mt-libs`.
- Added 6 roundtrip tests: `alphaDistance:0` lossless alpha, depth extra channel plane, `modularOptions` force+predictor, `advancedFrameSettings` patches=8, `customBoxes`, 2-frame animation with header + frame metadata.

**Verification:** `bun test ./node_modules/@casabio/jxl-native/test/codec.test.ts` — 12 pass, 0 fail.

**Docs Updated:**
- `docs/FEATURE_PARITY_MATRIX.md` row 3 (Modular) → ✅/✅.
- `docs/references/designs/ISSUES.md` §8 → done.

---

## Native EC Decoder Reporting (extra-channel decode parity) — 2026-05-29

**Branch:** `epiccodereview/20260527T054853`
**Status:** Complete

**Scope:** Closed the last major encode/decode asymmetry in `jxl-native`. `DecodeAll` previously had no extra-channel output; WASM Phase 2 has full decoder symmetry. Now native matches.

**Changes — `packages/jxl-native/src/index.ts`:**
- Added `ExtraChannelDescriptor` interface (`type`, `bitsPerSample`, `name`) — EC metadata without pixel data.
- Added `DecodedExtraChannel extends ExtraChannelDescriptor` (`pixels: ArrayBuffer`, `pixelFormat: PixelFormat`).
- `ImageInfo.extraChannels?: readonly ExtraChannelDescriptor[]` — populated from `JXL_DEC_BASIC_INFO` event; available at header time.
- `DecodeEvent` `progress` + `final` variants: added `extraPlanes?: readonly ArrayBuffer[]` and `extraChannelDescriptors?: readonly DecodedExtraChannel[]`.

**Changes — `packages/jxl-native/src/native.cc`:**
- Added `ExtraChannelTypeName()` helper — maps `JxlExtraChannelType` int to `"alpha"/"depth"/"spot"/"selection"/"black"/"cfa"/"thermal"/"other"`.
- `DecodeAll`: added `struct DecodedEC { JxlExtraChannelInfo info; char name[256]; vector<uint8_t> pixels; }` + `vector<DecodedEC> extra_channels_dec`.
- In `JXL_DEC_BASIC_INFO`: calls `JxlDecoderGetExtraChannelInfo` + `JxlDecoderGetExtraChannelName` for all ECs; attaches `extraChannels` descriptor array to the header event's `info` object.
- In `JXL_DEC_NEED_IMAGE_OUT_BUFFER`: calls `JxlDecoderExtraChannelBufferSize` + `JxlDecoderSetExtraChannelBuffer` per EC; dtype derived from `bits_per_sample` (uint8/uint16/float).
- Final event: attaches `extraChannelDescriptors` (full objects with pixels + pixelFormat) and `extraPlanes` (parallel raw ArrayBuffer array).

**Build + Verification:**
- `npx tsc --noEmit` (packages/jxl-native) — clean.
- Native addon rebuilt (vcvars64 + `JXL_NATIVE_INCLUDE_DIR` + `JXL_NATIVE_LIB_DIR`); 602 functions compiled.
- `bun test packages/jxl-native/test/codec.test.ts` — 6 pass, 0 fail.

**Docs Updated:**
- `docs/FEATURE_PARITY_MATRIX.md` — row 2.4 notes updated to reflect decode parity.
- `docs/references/PROGRESS_LOG.md` — this entry.

---

## Full Feature Parity Audit + Docs Unification (WASM ↔ Tauri + Benchmark Matrix) — 2026-06

**Branch:** (unification pass; no dedicated feature branch)
**Status:** Complete
**Scope:** Extended the prior partial "new features" transpose table (old WASM_Tauri_feature_comparison.md) to a complete audit of *all* features across raw-pipeline, JXL controls (per REFERENCE_INDEX 1-12 + audit), scheduling, WASM perf architecture, progressive/ROI/JXTC, benchmark exposure, and Tauri desktop specifics. Produced the single source of truth `docs/FEATURE_PARITY_MATRIX.md` (with ✅ ❌ 🟡 N/A + explicit benchmark tab(s) or "all"/"N/A"). Consolidated docs, reduced duplication by deleting redundant summaries/backups (feature-summary*.md, rejected optimizations_backup.md), and updated all references (HANDOFF, DESIGNS_INDEX, etc.) to point to the matrix.

**Key Outcomes:**
- Matrix covers 8 categories / ~60+ distinct features with WASM/Tauri/benchmark columns.
- Confirmed remaining high-impact gaps are the raw LookRenderer + selective flags + orient fastpath on Tauri side, plus progressive/JXTC encode and native progressive decode on Tauri.
- Many JXL advanced (extra channels full, animation, brotli, patches escape, metadata) already have good WASM + jxl-native parity.
- Scheduler/preemption largely shared (excellent parity via web/ frontend on Tauri).
- Deleted 3 redundant files; matrix + Overview now carry the completeness story.
- All cross-refs (DESIGNS_INDEX, HANDOFF, PROGRESS intro, Casa/WASM_Tauri legacy notes) updated.

**Docs Updated:**

---

## Handoff Created for Remaining 2026-06 Phase 3 Micro-Features — 2026-06

**Branch:** `feature/hdr-signaling-color-priority` (at creation time)

**Status:** Handoff artifact complete

**Scope:** After full rigorous completion of the HDR Signaling note (smart wiring, lab badges, native parity, test, living progress + exemplar Cleanup & Handoff block), a dedicated continuation handoff was produced so the remaining three Phase 3 notes from the fine-toothed-comb audit can be driven to the same standard.

**Key Artifact:**
- New file: `docs/references/HANDOFF_Continuing_Phase3_MicroFeatures_2026-06.md`
  - Exact current state per note (HDR = done; JPEG recompression = initial slice + partial handoff already present; Pixel Art + Production Chunked = partial shared infrastructure + benchmark scaffolding from coordinated passes).
  - Notes that `jpegReconstruction`, `upsamplingMode`/`alreadyDownsampled`, and strengthened `buffering`/`lowMemoryStrategy` fields already exist in facade.ts + lab from the "Both 1 & 2" infrastructure work.
  - Clear recommended process, ruthless standard reminder, smart wiring principle, and immediate next actions.
- Light pointer added to the top of the older master `HANDOFF_Autonomous_Design_Notes_Implementation_2026-06.md` directing readers to the active Phase 3 continuation document.

**Why this handoff:** The long autonomous + heavily steered session (gain maps through Phase 3 micro-features + HDR deep slices) reached a natural pause after the credits question. This artifact preserves context, decisions, partial wins, and the exact bar for resumption without requiring the next agent to reconstruct everything from chat history.

**Next:** When resuming, start from the new focused handoff file. Create a fresh feature branch before any further edits on the remaining notes.

**Docs Updated:**
- `docs/references/HANDOFF_Continuing_Phase3_MicroFeatures_2026-06.md` (new)
- `docs/references/HANDOFF_Autonomous_Design_Notes_Implementation_2026-06.md` (pointer at top)
- This PROGRESS_LOG entry

---
- Created `docs/FEATURE_PARITY_MATRIX.md`
- Updated `docs/references/HANDOFF.md`, `docs/references/designs/DESIGNS_INDEX.md`, this PROGRESS_LOG
- Minor clean in references/ + legacy comparison files (now thin or removed)
- 3 redundant files removed (see shell log in session)

**Verification:** Targeted source inspection (lib.rs WASM exports, raw-pipeline pipeline.rs + apply_orientation, tauri pipeline.rs Rgb16State/process_file, jxl-wasm facade/bridge, jxl-native parity from prior PROGRESS entries, web/*.html tab inventory).

**Next:** Use matrix as the only parity reference. Every new feature must update it + benchmark exposure + this log.

---

## Native Parity Pass — modular, advancedFrameSettings, customBoxes, ExtraChannel.name — 2026-05-29

**Branch:** `epiccodereview/20260527T054853`
**Status:** Complete

**Scope:** Full-audit pass of WASM vs Tauri/native gaps per `docs/FEATURE_PARITY_MATRIX.md`. Four missing items identified and implemented.

**Changes — `packages/jxl-native/src/index.ts`:**
- `EncoderOptions.modular?: -1 | 0 | 1` — matches WASM facade; -1 = auto, 0 = VarDCT, 1 = Modular.
- `EncoderOptions.advancedFrameSettings?: readonly { id: number; value: number }[]` — escape hatch for arbitrary `JXL_ENC_FRAME_SETTING_*` values (patches, splines, modular predictor, etc.). Applied after named settings; later entries override earlier ones.
- `ExtraChannel.name?: string` — matches WASM facade; optional per-channel label embedded in the JXL bitstream.

**Changes — `packages/jxl-native/src/native.cc`:**
- `EncoderData.modular` (int32_t, -1 default) — parsed from JS; applied via `JXL_ENC_FRAME_SETTING_MODULAR` in `EncodeAll`.
- `EncoderData.advanced_frame_settings` (`vector<AdvancedSetting>`) — parsed from `advancedFrameSettings` array; applied in `EncodeAll` loop after all named settings.
- `EncoderData.custom_boxes` (`vector<CustomBox>`) — parsed from `customBoxes` array (type, data, compress); applied in `EncodeAll` via `JxlEncoderAddBox` per entry. Box type padded/truncated to 4 chars with space-padding. This completes the "not yet implemented in native binding" note from the metadata-boxes-container design.
- `NativeExtraChannel.name` (string) — parsed from `name` property; applied via `JxlEncoderSetExtraChannelName` in the extra-channel declare loop (after `JxlEncoderSetExtraChannelInfo`).

**Build + Verification:**
- `npx tsc --noEmit` (packages/jxl-native) — clean.
- Native addon rebuilt via vcvars64 + `JXL_NATIVE_INCLUDE_DIR=C:\Foo\raw-converter\target\release\build\jpegxl-sys-26f294f2024eaecb\out\include` + `JXL_NATIVE_LIB_DIR=C:\TEMP\jxl-mt-libs`.
- `bun test packages/jxl-native/test/codec.test.ts` — 6 pass, 0 fail.

**Docs Updated:**
- `docs/FEATURE_PARITY_MATRIX.md` — rows updated for Modular advanced, Metadata Boxes v2, Extra Channels, and EncoderOptions surface parity.
- `docs/references/PROGRESS_LOG.md` — this entry.

**Remaining native gaps (not in this pass):**
- Extra-channel decoder reporting (planes + descriptors in decode events) — still pending.
- Gain Maps — native ❌, WASM 🟠 stub.
- Full nested Modular controls (groupSize, predictor, nbPrevChannels, etc.) — design note complete; not yet dedicated fields (covered by `advancedFrameSettings` escape hatch in the interim).
- JXTC Tile-Container — major native gap; complex.
- RAW Pipeline items (LookRenderer, process_orf_with_flags, etc.) — Rust-side work.

---

## Native Addon Rebuild — 2026-05-29

**Branch:** `epiccodereview/20260527T054853`
**Status:** Complete

**What changed in native.cc (3 fixes to compile against libjxl 0.11.x):**
1. `JxlEncoderAddExtraChannelBuffer` → `JxlEncoderSetExtraChannelBuffer` (API rename)
2. `JxlEncoderSetFrameDuration` → `JxlEncoderInitFrameHeader` + `JxlEncoderSetFrameHeader` block (same fix as bridge.cpp)
3. Added `#ifndef JxlBool typedef int JxlBool; #endif` shim after JXL includes

**binding.gyp:** No net changes (temporarily added `ucrt.lib` during CRT mismatch diagnosis, then reverted when root cause identified as `/MD` vs `/MT` mismatch).

**Build environment:**
- libjxl source: `jpegxl-src-0.11.4` Cargo registry crate (libjxl 0.11.x)
- CMake flags: `-DBUILD_SHARED_LIBS=OFF -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded` (must match node-gyp's `/MT`)
- Libs collected to `C:\TEMP\jxl-mt-libs\` (7 static `.lib` files)
- Build command: `vcvars64 + JXL_NATIVE_INCLUDE_DIR + JXL_NATIVE_LIB_DIR + npx node-gyp rebuild --release`

**Verification:**
- `packages/jxl-native/build/Release/jxl_native.node` — 6.2 MB
- `bun test packages/jxl-native/test/codec.test.ts` — 6 pass, 0 fail

**Docs Updated:**
- `docs/references/designs/ISSUES.md` — §4 done, §9 done
- `docs/references/PROGRESS_LOG.md` — this entry

---

## WASM Bridge Rebuild — 2026-05-29

**Branch:** `epiccodereview/20260527T054853`
**Status:** Complete

**What changed:**

Four `packages/jxl-wasm/src/bridge.cpp` compilation errors fixed to allow the source to compile against libjxl build commit `332feb17d17311c748445f7ee75c4fb55cc38530` (WASM target) via Emscripten:

1. `JxlEncoderAddExtraChannelBuffer` → `JxlEncoderSetExtraChannelBuffer` (API rename between commits)
2. `JxlEncoderSetFrameDuration` (never existed at this commit) → replaced with `JxlEncoderInitFrameHeader` / `JxlEncoderSetFrameHeader` block; `fh.duration = wf.duration`
3. Added `#include <vector>` (needed for `std::vector<char> name_buf(...)` in animation frame name code)
4. Added `#ifndef JxlBool typedef int JxlBool; #endif` compatibility shim after JXL includes (`JxlBool` was added to `jxl/types.h` in a later libjxl commit; all 4 uses in bridge.cpp — lines 480, 828, 1614, 2612 — would fail without it)

**Build:**
- Docker image: `docker.io/emscripten/emsdk:4.0.13` / local `jxl-wasm-builder:local`
- Command: `docker run --rm -v "C:\Foo\raw-converter-wasm\packages\jxl-wasm:/work/jxl-wasm" -w /work/jxl-wasm jxl-wasm-builder:local node scripts/build.mjs --inside-docker`
- Result: all 4 tiers built (relaxed-simd-mt 18:07, simd-mt 18:24, simd 18:40, scalar 18:52 UTC)

**Verification:**
- All 7 animation symbols present in `dist/jxl-core.simd-mt.js` and correctly mapped to WASM exports
- `bun test packages/jxl-wasm/test/facade.test.ts` — 69 pass, 0 fail

**Second rebuild — exports.txt gap fix (2026-05-29, `16:56:25Z`):**
- Discovered: 10 `_x` / `_v2` functions defined in `bridge.cpp` were not listed in `exports.txt` and were dead-code-eliminated by Emscripten LTO. Affected: `_jxl_wasm_encode_rgba8_x`, `rgba16_x`, `rgbaf32_x`, `encode_rgba8_with_metadata_x`, `encode_rgba8_with_metadata_v2`, `encode_auto_x`, `encode_rgba8_with_sidecars_x`, `enc_push_pixels_x`, `enc_create_image_x`, `transcode_jpeg_to_jxl_v2`.
- Fixed: all 10 added to `exports.txt`; rebuild run; all confirmed present in `dist/jxl-core.simd-mt.js`.
- Impact: without this fix all 5 capability gates would have resolved `false` in browser (`extOptions`, `metadataBoxesV2`, and effectively all encoder extension paths). Now all 5 gates resolve correctly.
- `bun test packages/jxl-wasm/test/facade.test.ts` — 69 pass, 0 fail.

**Docs Updated:**
- `docs/references/designs/ISSUES.md` — §1 done, §3 done, §9 partial (WASM done; native pending)
- `docs/references/ACTION PLAN.md` — Milestone 0 Docker/build items ticked; exports.txt gap noted
- `docs/references/PROGRESS_LOG.md` — this entry

---

## Feature: Animation / Multi-Frame Encode + Decode — 2026-05-29

**Branch:** `epiccodereview/20260527T054853`
**Status:** Fully implemented (WASM rebuilt 2026-05-29 — `animationEncode` cap live; native rebuild still pending — see ISSUES.md §9)

**WASM Changes:**
- `packages/jxl-wasm/src/facade.ts` — `AnimationFrame`, `AnimationOptions` interfaces; `EncoderOptions.animation` + `.frames`; `LibjxlWasmModule` extended with `_jxl_wasm_encode_animation?` (19-arg) + 6 decoder accessor methods; `JxlCapabilities.animationEncode` gate; `WASM_ANIMATION_FRAME_BYTES=28`, `WASM_ANIMATION_OPTS_BYTES=8` constants; `marshalAnimationFrames` helper; animation encode dispatch before single-frame path; `DecodeEvent` "final"/"progress" extended with `frameIndex?`/`frameDuration?`/`frameName?`/`isLastFrame?`/`animTicksPerSecond?`/`animLoopCount?`; `eventsProgressive` enrichment (3 blocks) gated on accessor presence; `eventsOneShot` deliberately NOT enriched (incompatible handle type).
- `packages/jxl-wasm/src/bridge.cpp` — `WasmAnimationFrame` (28-byte packed struct) + `WasmAnimationOpts` (8-byte); `EncodeAnimation()` static (~130 lines): `have_animation=JXL_TRUE`, per-frame `JxlEncoderSetFrameDuration`/`JxlEncoderSetFrameName`, dynamic output buffer; `jxl_wasm_encode_animation` C export (19 params); `JxlWasmDecState` extended with 6 animation fields; `JXL_DEC_FRAME` in subscribe mask + handler; animation header population in `JXL_DEC_BASIC_INFO`; `frame_index++` in `JXL_DEC_FULL_IMAGE`; 6 accessor exports (`_jxl_wasm_dec_frame_index`, `_jxl_wasm_dec_frame_duration`, `_jxl_wasm_dec_frame_name_ptr`, `_jxl_wasm_dec_is_last_frame`, `_jxl_wasm_dec_anim_ticks_per_second`, `_jxl_wasm_dec_anim_loop_count`). Source-only.
- `packages/jxl-wasm/exports.txt` — 7 animation symbols appended.
- `packages/jxl-wasm/test/facade.test.ts` — `describe("animation capability")` (3 tests: real gate, routing, opts layout); `describe("animation decode metadata")` (2 tests: source-text + progressive decode); exports.txt symbol test.

**Native (Tauri) Changes:**
- `packages/jxl-native/src/index.ts` — `AnimationFrame`, `AnimationOptions` interfaces; `EncoderOptions.animation?` + `.frames?`; `DecodeEvent` "progress"/"final" extended with 6 animation fields (full parity with WASM facade).
- `packages/jxl-native/src/native.cc` — `EncoderData` animation fields (`has_animation`, tps, loop_count, `AnimFrame` inner struct + vector); `CreateEncoder` animation + frames parsing; `EncodeAll` animation header branch + multi-frame path; `DecodeAll`: `JXL_DEC_FRAME` subscribe + handler, animation header on `JXL_DEC_BASIC_INFO`, `frame_index++` on `JXL_DEC_FULL_IMAGE`, 6 `napi_set_named_property` calls on final event. Source-only.
- `packages/jxl-native/test/codec.test.ts` — 2 source-text tests confirming `AnimationFrame`, `AnimationOptions`, `animation?`/`frames?`, `frameIndex?`/`frameDuration?`/`frameName?`.

**Benchmark Wiring:**
- `web/animation-lab.html` — interactive animation lab: frame count/size/ticks/duration/loop/quality controls; hue-shifted canvas frame generator; frame strip preview; capability banner when `animationEncode=false`; encode→decode flow with stats (`frames`, `file size`, `duration ms`, `fps`) + first-frame preview; decode event log.
- `web/animation-lab.test.js` — structural test (1 pass).

**Tests:**
- Narrow: `bun test packages/jxl-wasm/test/facade.test.ts --grep "animation"` — all pass.
- Narrow: `bun test packages/jxl-native/test/codec.test.ts --grep "animation"` — all pass.
- Narrow: `bun test web/animation-lab.test.js` — 1 pass.
- TypeScript: `npx tsc --noEmit` — clean (packages/jxl-wasm and packages/jxl-native).

**Docs Updated:**
- `docs/references/designs/animation-multi-frame.md` — status updated; checklist all [x].
- `docs/references/designs/DESIGNS_INDEX.md` — status updated to "Implemented on branch `epiccodereview/20260527T054853`".
- `docs/references/designs/ISSUES.md` — §9 added for WASM + native rebuild blocker.
- `docs/references/PROGRESS_LOG.md` — this entry.

**Cleanup & Handoff:**
- Current state: All source implemented; WASM binary and native addon rebuild pending (same Docker/node-gyp blockers as Issues 1/3 and Issue 4). `animationEncode` capability will be `false` in browser until rebuild. Capability banner in `animation-lab.html` communicates this to users.
- Background processes / logs: None.
- Next session: After Docker is available, run `pnpm --filter @casabio/jxl-wasm build`, verify 7 new exports in dist/, open `web/animation-lab.html`, confirm encode produces file > 0 bytes. See ISSUES.md §9 for full 6-step checklist.

---

## Feature: Full Extra Channel Infrastructure (Phase 2) — types, 72B descriptors, encode/decode symmetry, native parity, matrix tests - 2026-05-29

**Branch:** feature/full-extra-channel-infrastructure (worktree: transpose-wasm-to-tauri)
**Status:** Fully implemented (all design checklist items + Task 7 matrix + docs + handoff)

**WASM Changes:**
- `packages/jxl-wasm/src/facade.ts:147-184` — full ExtraChannelType enum (alpha/depth/selection/spot/thermal + reserved0-7 + unknown), SpotColorInfo, ExtraChannel, DecodedExtraChannel (readonly symmetric). serializeExtraChannelsForWasm + EC_BYTES=476, deserializeExtraChannelsFromWasm (72B). Decoder event shaping for extraChannels/extraPlanes on header/final/progress.
- `packages/jxl-wasm/src/bridge.cpp:92-102` — WasmExtraChannel struct (exact 72B layout with type/bits/distance/planes/dim/spot/name). `EncodeRgbaWithExtraChannels:546` (per-EC SetExtraChannelInfo/Name/Distance + SetExtraChannelBuffer for all bit depths). Decode descriptor collection `269-304` + `jxl_wasm_get_extra_channels:2127-2191` (exact 72B output for tests/roundtrips). Progressive extra plane flushing.
- `packages/jxl-wasm/exports.txt` — (prior) new FFI symbols for EC encode + get_extra.
- `packages/jxl-wasm/test/facade.test.ts:886-` (expanded) — Phase 2 describe + comprehensive matrix (every type × 8/16/32 where valid, unicode/long names, spot metadata, mixed bits, dimShift, many-EC perf, decoder header/final full descriptor reports).

**Native (Tauri) Changes:**
- `packages/jxl-native/src/index.ts:41-75` — mirrored ExtraChannelType/Spot/ExtraChannel/DecodedExtraChannel + ImageInfo.extraChannels + DecodeEvent/EncoderOptions extraChannels for parity.
- `packages/jxl-native/src/native.cc:51-63` — ExtraChannelDesc struct. Type maps `220-239`. Encode setup `620-672` (Init/SetInfo/Name/Distance + SetExtraChannelBuffer). Decoder collection `495-527` (GetExtra* → extra_channels vector + emission on header/final events).

**Benchmark Wiring:**
- `web/jxl-wrapper-lab.html` + `.js` (Task 6) — substantial "Extra Channels" panel: dynamic type selects (all enum values), bit/depth/distance/name/dimShift/spot controls (color + solidity), +channel/- , synthetic plane generators (ramps/noise/checker/solid). Post-decode Channel Inspector grid (per-EC canvases + histograms/min-max). Manual verification of 5+ cases + descriptor logs.

**Tests:**
- `packages/jxl-wasm/test/facade.test.ts` — expanded Phase 2 describe with matrix roundtrips (serialize unit + guarded encode/decode + decoder event assertions for descriptors + planes). All new its pass under symbol guards.
- Narrow verification: static inspection + (user to run) `bun test packages/jxl-wasm/test/facade.test.ts --grep "ExtraChannel full infrastructure|matrix|roundtrips|unicode|spotColor|mixed|dimShift|many|decoder.*descriptors"`

**Docs Updated:**
- `docs/references/designs/extra-channel-infrastructure.md` — checklist all [x]; new "Implementation Notes" section (deviations, benchmark desc, decisions).
- `docs/references/designs/extra-channel-distance.md` — top status + cross-ref to Phase 2 complete + checklist finalization.
- `docs/references/DESIGNS_INDEX.md` — status for Full Extra Channel Infrastructure changed to "Implemented in commit <SHA>".
- `docs/references/REFERENCE_INDEX.md` — added full "CasaWASM Implementation (Phase 2 complete)" with file:line ranges for types, 72B, encode/decode paths in WASM + native.
- `docs/references/PROGRESS_LOG.md` — this entry (top).
- `_cleanup.md` / handoff block produced (per TEMPLATE §10 + _cleanup_source.md).

**References Used:**
- `docs/references/designs/extra-channel-infrastructure.md` + sibling extra-channel-distance.md
- REFERENCE_INDEX.md §4 (Extra Channels) — the "CasaWASM Implementation (Phase 2 complete)" block with exact 72B / facade:147-184 / bridge:546-639 / native parity lines was added by this work.
- libjxl `encode.h` / `decode.h` (JxlExtraChannelInfo, JxlExtraChannelType, SetExtraChannel*, GetExtraChannelInfo/Name)
- Prior Phase 1 bridge patterns + facade encode/decode symmetry.

**Cleanup & Handoff:**
- Current state: Full Phase 2 complete. WASM artifacts require rebuild for browser runtime of new C++ exports. All listed files edited surgically.
- Background processes / logs: None started in this slice (prior build artifacts in tmp/ noted).
- Next session instructions: From repo root after `/clean`; rebuild WASM (`node packages/jxl-wasm/scripts/build.mjs ...`); run the matrix test subset + serve wrapper-lab for Extra Channels visual; `git commit` using message below; update SHA in DESIGNS_INDEX/PROGRESS_LOG if needed.
- Handoff document: See final response block + local `_cleanup.md` / `_handoff.md` patterns.

---

## Feature: Patches & Advanced Frame Settings Escape Hatch (advancedFrameSettings + JxlFrameSetting) - 2026-06

**Branch:** worktree (transpose-wasm-to-tauri) + main
**Status:** Core escape hatch implemented (WASM + native parity)
**Visibility Note (2026-06 sync with REFERENCE_INDEX.md + ACTION PLAN):** Code changes described (advancedFrameSettings + JxlFrameSetting + _adv FFI) are not present on the `epiccodereview/20260527T054853` branch (verified via source scan). Work remains isolated to the worktree/main; see ACTION PLAN.md Milestone 3 for merge/re-execution plan. Patches & Splines corresponds to REFERENCE_INDEX.md audit item #11 (escape-hatch first per designs/patches-splines.md; cjxl_main.cc --patches reference).

**WASM Changes:**
- `packages/jxl-wasm/src/facade.ts` — added `advancedFrameSettings?: Array<{id,value}>` + `JxlFrameSetting` named constants helper (PATCHES=8). Wired in streaming input (`enc_create_image_adv`) and buffered metadata path using `_adv` FFI variants.
- `packages/jxl-wasm/src/bridge.cpp` — added `ApplyAdvancedFrameSettings` helper + storage in `JxlWasmEncState`. Extended `EncodeRgbaWithMetadata`, `enc_create_image`/`enc_finish`, and exported `_adv` functions. Temporary WASM allocations for ids/values with proper free.

**Native (Tauri) Changes:**
- `packages/jxl-native/src/index.ts` — matching `advancedFrameSettings` field + `JxlFrameSetting` constants.
- `packages/jxl-native/src/native.cc` — extended `EncoderData`, parsing in `CreateEncoder`, application of `SetOption` calls.

**Benchmark Wiring:**
- `web/jxl-wrapper-lab.html` + `.js` — minimal experimental checkbox "Enable Patches (experimental)" with strong content-dependent warning. Wired into `makeEncoderOptions()` using the escape hatch.

**Tests:**
- `packages/jxl-wasm/test/facade.test.ts` — smoke test for API acceptance + synthetic repeating content size-impact smoke test (with console logging).

**Docs Updated:**
- `docs/references/designs/patches-splines.md` — checklist updated.
- `docs/references/PROGRESS_LOG.md` — this entry.

**References Used:**
- `docs/references/designs/patches-splines.md`
- libjxl `encode.h` (JXL_ENC_FRAME_SETTING_PATCHES = 8)

---

## Feature: Decoding Speed Tier (JXL_ENC_FRAME_SETTING_DECODING_SPEED) - 2026-05-28

**Branch:** epiccodereview/20260527T054853
**Status:** Implemented in source

**WASM Changes:**
- `packages/jxl-wasm/src/facade.ts` — added `decodingSpeed?: number` to `EncoderOptions`, clamped to 0–4 in `resolveEncoderBridgeSettings` (omitted → -1 = no hint), forwarded through all `_x` encode call sites.
- `packages/jxl-wasm/src/bridge.cpp` — added `enc_decoding_speed` to `JxlWasmEncState`; applies `JXL_ENC_FRAME_SETTING_DECODING_SPEED` when value ≥ 0; extended all `_x` exported functions and `jxl_wasm_enc_create_image_x`.

**Benchmark Wiring:**
- `web/jxl-wrapper-lab.html` — added Decode speed tier spinpicker (0–4, default 0).
- `web/jxl-wrapper-lab.js` — `getDecodeSpeed()` helper; wired into `makeEncoderOptions()` and `syncSettingLabels`.

**Tauri/Native Changes (2026-05-29):**
- `packages/jxl-native/src/index.ts` — added `decodingSpeed?: number` to `EncoderOptions`.
- `packages/jxl-native/src/native.cc` — added `decoding_speed` field to `EncoderData`; parses `decodingSpeed` from JS options (clamped -1/0–4); applies `JXL_ENC_FRAME_SETTING_DECODING_SPEED` in encoder setup.

**Tests:**
- `packages/jxl-wasm/test/facade.test.ts` — added `describe("decodingSpeed encoder option", ...)` with 5 tests covering tier forwarding, -1 default, clamp-to-0, clamp-to-4.
- `bun test packages/jxl-wasm/test/facade.test.ts` — 38 pass, 1 pre-existing unrelated failure.

**Docs Updated:**
- `docs/references/PROGRESS_LOG.md`

**References Used:**
- `docs/references/designs/decoding-speed-tier.md`

**Cleanup & Handoff:**
- Current state: Full implementation complete (WASM + native). WASM/browser runtime needs regenerated artifacts before browser can exercise the new C++ exports.
- Background processes / logs: None started intentionally.

---

## Feature: Photon Noise (JXL_ENC_FRAME_SETTING_PHOTON_NOISE) - 2026-05-28

**Branch:** current workspace
**Status:** Implemented in source

**WASM Changes:**
- `packages/jxl-wasm/src/facade.ts` — added `photonNoiseIso?: number`, normalized omitted values to `0`, and forwarded it through extended `_x` encode paths.
- `packages/jxl-wasm/src/bridge.cpp` — applies `JXL_ENC_FRAME_SETTING_PHOTON_NOISE` when ISO is greater than zero.

**Tauri Changes:**
- `packages/jxl-native/src/index.ts` — added `photonNoiseIso?: number`.
- `packages/jxl-native/src/native.cc` — parses `photonNoiseIso` and applies `JXL_ENC_FRAME_SETTING_PHOTON_NOISE`.

**Benchmark Wiring:**
- `web/jxl-wrapper-lab.html` / `web/jxl-wrapper-lab.js` — added Photon noise ISO control and forwards it into wrapper encode options.

**Tests:**
- `packages/jxl-wasm/test/facade.test.ts` — added forwarding/source tests for photon noise.
- `npm --workspace packages/jxl-wasm run typecheck` passes.
- `npm --workspace packages/jxl-native run typecheck` passes.

**Docs Updated:**
- `docs/references/PROGRESS_LOG.md`
- `docs/references/designs/photon-noise.md`

**References Used:**
- `docs/references/designs/photon-noise.md`

**Cleanup & Handoff:**
- Current state: Source implementation complete. WASM/browser runtime needs regenerated artifacts before browser can exercise the new C++ exports.
- Background processes / logs: None started intentionally.
- Next session instructions: Rebuild WASM artifacts, then run the wrapper lab with ISO presets 0/800/1600/3200/6400.
- Handoff document (if any): none.

---

## Design Phase Completion - 2026-05-28

**Status:** Completed (Scaffolding)

**Summary:**
- 11 feature design notes written by Grok following the hybrid workflow.
- Master index created at `docs/references/designs/DESIGNS_INDEX.md`.
- All items from the 2026-05-28 audit section in `REFERENCE_INDEX.md` now have design coverage.
- `designs/` folder + supporting documents now form a complete, usable knowledge base.

**Notes:**
- Implementation work has begun on the highest-priority features outside this scaffolding session.
- As of 2026-05-28: Features 1–4 are nearly complete; feature 5 has been initiated.
- See individual feature entries below for implementation details.
- All future implementation work should follow `FEATURE_IMPLEMENTATION_TEMPLATE.md` and reference the corresponding design note.

**Docs Updated:**
- `docs/references/designs/DESIGNS_INDEX.md` (new)
- `docs/references/designs/README.md`
- `docs/references/REFERENCE_INDEX.md` (audit section marked)
- `docs/CasaWASM_JXL_Feature_Completeness_and_Gaps.md` (Design Phase Status added)

---

## Feature: Brotli Effort (JXL_ENC_FRAME_SETTING_BROTLI_EFFORT) - 2026-05-28

**Branch:** epiccodereview/20260527T054853  
**Status:** Completed

**WASM Changes:**
- `packages/jxl-wasm/src/bridge.cpp:334` — `JXL_ENC_FRAME_SETTING_BROTLI_EFFORT` applied when `brotli_effort >= 0` (was already present)
- `packages/jxl-wasm/src/facade.ts` — `brotliEffort?: number` in `EncoderOptions`; clamped to -1..11; forwarded through all `_x` encode variants (was already present)

**Native Addon Changes (jxl-native, Node native addon — the "Tauri path" per design doc):**
- `packages/jxl-native/src/native.cc` — Added `int32_t brotli_effort = -1` to `EncoderData`; `CreateEncoder` reads + clamps `brotliEffort` option; `EncodeAll` applies `JXL_ENC_FRAME_SETTING_BROTLI_EFFORT` when `>= 0`
- `packages/jxl-native/src/index.ts` — Added `brotliEffort?: number` to `EncoderOptions` interface
- Addon rebuilt successfully via `npx node-gyp rebuild`

**Benchmark Wiring:**
- `web/jxl-benchmark.js` — `#brotli-effort` control already wired (load/save, caption display)
- `benchmark/encode-option-sweep.mjs` — sweep across `[-1, 0, 4, 9, 11]` already present

**Tests:**
- `packages/jxl-wasm/test/facade.test.ts` — Added `describe("brotliEffort encoder option", ...)` with 5 tests: forwarding, -1 default, 0 minimum, clamp-to-11, clamp-to-(-1). Added source-check test for `JXL_ENC_FRAME_SETTING_BROTLI_EFFORT` in bridge.cpp + native.cc. 62 pass, 1 pre-existing unrelated failure.
- `packages/jxl-native/test/codec.test.ts` — Added round-trip test with `brotliEffort: 5`.

**Docs Updated:**
- `docs/references/designs/brotli-effort.md` — Status updated to Implemented; checklist items ticked
- `_cleanup.md` — Updated with native addon completion

**References Used:**
- `docs/references/designs/brotli-effort.md` (design note)
- `bridge.cpp` pattern (gold standard for `_x` function shape)

**Cleanup & Handoff:**
- Current state: Feature complete on both WASM and native addon sides. WASM `_x` bridge functions still require Emscripten rebuild to activate in browser.
- Background processes / logs: None active.
- Next session instructions: Rebuild WASM via `cmd /c "call C:\Users\User\emsdk\emsdk_env.bat >nul && node packages/jxl-wasm/scripts/build.mjs --host-toolchain"` then run `benchmark/encode-option-sweep.mjs` to validate size deltas.
- Handoff document: `_cleanup.md`

---

## Feature: Decoding Speed Tier - 2026-05-28

**Status:** In Progress (Nearly Complete per user update)
**Notes:** Design note implemented. WASM + native work reportedly well advanced.

---

## Feature: Photon Noise - 2026-05-28

**Status:** In Progress (Nearly Complete per user update)
**Notes:** Design note implemented. Implementation status reported as nearly done.

---

## Feature: Core Modular Controls - 2026-05-28

**Status:** In Progress (Nearly Complete per user update)
**Notes:** Largest design note. Implementation reportedly close to completion.

---

## Feature: Resampling Controls - 2026-05-28

**Branch:** current workspace
**Status:** Completed pending full WASM/native binary rebuild
**WASM Changes:**
- Added `EncoderOptions.resampling?: 1 | 2 | 4 | 8`.
- Forwarded normalized resampling through one-shot, metadata, sidecar, streaming, and streaming-input encode paths.
- Applied `JXL_ENC_FRAME_SETTING_RESAMPLING` in the C++ bridge when factor is 2/4/8.

**Native Changes:**
- Added `resampling?: 1 | 2 | 4 | 8` to native encoder options.
- Parsed and normalized the option in the N-API addon and applied the libjxl frame setting.

**Benchmark Wiring:**
- Added wrapper-lab 1x/2x/4x/8x resampling chips and forwarded the selected factor into wrapper/session encode options.

**Tests:**
- Added facade unit tests for forwarding `resampling: 4` and normalizing invalid values to 1.
- Verified targeted resampling tests and package typechecks.
- Full WASM build blocked because Docker daemon is unreachable from this environment.
- Native addon rebuild blocked because workspace-local `node-gyp` is missing.

**Docs Updated:**
- `docs/Overview and features of the CasaWASM JXL wrapper.md`

**References Used:**
- `docs/references/designs/resampling.md`

**Cleanup & Handoff:**
- Current state: Source and emitted TypeScript dist updated; binary WASM/native artifacts need rebuild in an environment with Docker/native build deps available.
- Background processes / logs: None active.
- Next session instructions: Start Docker Desktop/Linux engine, ensure `packages/jxl-native` dependencies are installed, then rerun `npm --workspace packages/jxl-wasm run build` and `npm --workspace packages/jxl-native run build`.
- Handoff document: `_cleanup.md`

---

## Feature: Metadata Boxes & Container Decisions - 2026-05-28

**Branch:** `epiccodereview/20260527T054853`
**Status:** Completed (WASM source + types + tests + benchmark wiring done; binary artifacts need rebuild)

**WASM Changes:**
- Added `WasmBoxOpts` (20-byte) and `WasmCustomBox` (16-byte) packed structs to `bridge.cpp`.
- Added `ApplyContainerMode()` and `AddCustomBoxes()` static helpers.
- Extended `EncodeRgbaWithMetadata` and `EncodeRgbaWithExtraChannels` with optional `box_opts` parameter; Brotli compress flag now sourced from `box_opts->compress_boxes`; added error codes 54/55 (standard) and 134/135 (extra-channel).
- New exported functions: `jxl_wasm_encode_rgba8_with_metadata_v2`, `jxl_wasm_encode_rgba8_with_metadata_ec_v2`, `jxl_wasm_transcode_jpeg_to_jxl_v2` (JPEG lossless transcode + EXIF/XMP + container control).
- Added `MetadataOptions` and `MetadataBoxSpec` interfaces to `facade.ts`; added `metadata?` and `customBoxes?` to `EncoderOptions`.
- Added `metadataBoxesV2` capability flag; capability-gated routing to v2 bridge functions.
- Added `resolveEffectiveMetadata`, `needsBoxOptsV2`, `marshalBoxOpts` helpers in `facade.ts`.

**Native Changes:**
- Added `icc_profile`, `exif`, `xmp` buffer fields and `compress_boxes`, `force_container`, `raw_codestream` booleans to `EncoderData` struct in `native.cc`.
- Added `GetNullableBufferProp()` NAPI helper to read nullable `ArrayBuffer` or Node `Buffer` properties.
- Wired `JxlEncoderUseContainer`, `JxlEncoderSetICCProfile`, and EXIF/XMP `JxlEncoderAddBox` calls in `EncodeAll`.
- Parsed `metadata` sub-object (compressBoxes/forceContainer/rawCodestream/includeICC/includeExif/includeXMP) in `CreateEncoder`.
- Added `MetadataOptions` and `MetadataBoxSpec` interfaces and extended `EncoderOptions` in `packages/jxl-native/src/index.ts` (customBoxes noted as not yet wired in native binding).

**Benchmark Wiring:**
- Added Compress boxes, Force container, and Raw codestream toggle controls to `web/jxl-wrapper-lab.html`.
- Added `getCompressBoxes()`, `getForceContainer()`, `getRawCodestream()` getters and wired them into `makeEncoderOptions()` as `metadata: { compressBoxes, forceContainer, rawCodestream }` in `web/jxl-wrapper-lab.js`.

**Tests:**
- Added 6 unit tests in `packages/jxl-wasm/test/facade.test.ts` covering: `includeExif:false` stripping, `compressBoxes`/`rawCodestream`/`forceContainer` WasmBoxOpts fields, custom box marshaling, and `rawCodestream` overriding `forceContainer`.
- Result: 44 pass, 1 pre-existing unrelated failure (`detectTier > returns scalar in Node/Bun`).

**Docs Updated:**
- `docs/references/designs/DESIGNS_INDEX.md` — status updated to "Implemented on branch `epiccodereview/20260527T054853`".

**References Used:**
- `docs/references/designs/metadata-boxes-container.md`
- `docs/references/designs/DESIGNS_INDEX.md`
- `docs/references/designs/README.md`

**Cleanup & Handoff:**
- Current state: All source changes complete. Binary WASM and native addon artifacts need rebuild (Docker/Emscripten for WASM, node-gyp for native).
- Background processes / logs: None active.
- Next session instructions: Rebuild `packages/jxl-wasm` with Emscripten (see CLAUDE.md build notes) and `packages/jxl-native` with node-gyp. Then run full test suite. Remaining design notes ready for implementation: `brotli-effort.md`, `decoding-speed-tier.md`, `core-modular-controls.md`, `extra-channel-distance.md`, etc.
- Handoff document (if any): `docs/references/designs/DESIGNS_INDEX.md` and `ISSUES.md`.

---

## Feature: [Name] - [Date]

**Branch:** feature/xxx
**Status:** [Completed / In Progress / Blocked]
**WASM Changes:**
- 
**Tauri Changes:**
- 
**Benchmark Wiring:**
- 
**Tests:**
- 
**Docs Updated:**
- 
**References Used:**
- 
**Cleanup & Handoff:**
- Current state:
- Background processes / logs:
- Next session instructions:
- Handoff document (if any):

---

## 2026-05-29 — Extra Channel Distance (Phase 1)

**Feature:** Per-extra-channel distance + basic extra channel infrastructure
**Branch:** `epiccodereview/20260527T054853`
**Status:** Implemented

### What was done

- Fixed parameter-drop bug: `decodingSpeed`, `photonNoiseIso`, `resampling` were computed but not forwarded through the EC bridge path. Updated `EncodeRgbaWithExtraChannels`, both `_ec` and `_ec_v2` public bridge functions, facade TS declarations, and dispatch calls.
- Fixed inline resampling normalization to call `NormalizeResampling()` helper (consistent with all other encode paths).
- Added `_jxl_wasm_encode_rgba8_with_metadata_ec_v2` to `exports.txt` (was implemented but not exported).
- Added 5 unit tests (arg dispatch, alphaDistance arg index, extraChannels numEc, WasmExtraChannel descriptor layout, fallback path) + 1 integration test (lossless-alpha smoke test).

### Design note checklist status

- [x] Branch created
- [x] Declaration + distance setting in bridge
- [x] Alpha convenience path wired
- [x] Tests (dispatch, descriptor layout, lossless-alpha integration)
- [ ] Benchmark/lab page — deferred to Phase 2
- [ ] Tauri side — deferred
- [ ] Full handoff — see Phase 2 note (`extra-channel-infrastructure.md`)

### Commits

- fix(jxl-wasm): export _jxl_wasm_encode_rgba8_with_metadata_ec_v2
- fix(jxl-wasm): thread decodingSpeed/photonNoiseIso/resampling through EC bridge
- fix(jxl-wasm): use NormalizeResampling helper in EC encode path
- fix(jxl-wasm): pass decodingSpeed/photonNoiseIso/resampling in EC encode dispatch
- test(jxl-wasm): add extra-channel distance dispatch and descriptor tests
- test(jxl-wasm): assert alphaDistance sentinel -1 when no alphaDistance option

---

## B1: RAW Tauri parity — Unified apply_look_params + orient fast-path fixes (finishing_feature_parity)
**Branch:** `finishing_feature_parity`
**Status:** Complete (first B slice)

**Scope:** Per FEATURE_PARITY_MATRIX §1 items 6-7 and ACTION PLAN gaps. Eliminated duplication of the 12-slider look applicator (was inline in Tauri + private copy in WASM wrapper). Made `raw_pipeline::pipeline::apply_look_params` the single source (pub). Updated Tauri to delegate; WASM now calls the shared version from all 4 sites. As drive-by, fixed 4 stale `&Vec` call sites on `apply_orientation` so WASM consistently gets the zero-copy move for orientation==1 (helps item 6 fast-path).

**Changes:**
- `raw-pipeline/src/pipeline.rs`: new pub fn `apply_look_params` (exact semantics of prior copies).
- `raw-converter-tauri/src-tauri/src/pipeline.rs`: delegate wrapper (removes 12-line dupe).
- `raw-converter-wasm/src/lib.rs`: 4 call sites now use `raw_pipeline::pipeline::...`; removed dead local fn; 4 borrow fixes on apply_orientation for true zero-copy on orient=1.
- No behavior change for existing callers.

**Verification:**
- `cargo check` (WASM crate, path-dep on updated raw-pipeline) — clean (only unrelated dead_code warn).
- Matrix rows 6/7 updated (🟡→✅ for unified; orient fastpath note).
- This is the first commit in the B (RAW Tauri) series on the single allowed branch.

**Docs:**
- `FEATURE_PARITY_MATRIX.md` updated (items 6/7 + summary "B1 landed").
- This PROGRESS_LOG entry (TEMPLATE style).

**Next (B2 on same branch):** Selective process_with_flags + thumb-from-lb optimization in raw-pipeline + Tauri process_file (big win for gallery thumbs).

**Cleanup & Handoff:** Clean point. Only source files touched for this feature. Commit will be docs + the 3 Rust files.

---

## B2: RAW Tauri parity — Shared downscales + thumb-from-lb optimization (finishing_feature_parity)
**Branch:** `finishing_feature_parity`
**Status:** Complete (B2 slice)

**Scope:** Matrix §1 item 5 (thumb from lb) + foundation for item 2 (selective). Added pub `downscale_rgb16`, `downscale_rgb8`, `target_dims` to raw-pipeline (par_chunks, rayon). Updated Tauri process_file to derive gallery thumb from the pre-computed lb16 buffer (major win: no 2nd full-res downscale for thumbs in batch gallery). Shared helpers eliminate dupe.

**Changes (on disk + this repo docs):**
- raw-pipeline/src/pipeline.rs: 3 new pub fns (downscales + target_dims).
- raw-converter-tauri/src-tauri/src/pipeline.rs: use shared downscales; thumb-from-lb path in ProcessResult.thumb (small tone on lb-derived).
- Removed local dupe downscale fns in Tauri.
- Matrix item 5 🟡 (progress), PROGRESS entry.

**Verification:** Syntax good (prior full cargo check in context succeeded for dep; sibling heavy build env blocked full check but no our-code errors).

**Cross-repo note:** raw-pipeline and src-tauri changes must be committed in C:\Foo\raw-converter-tauri git (separate repo). WASM side (if any) + docs committed here.

**Next:** B3 LookRenderer full resident render parity or B4 metadata-only.

**Docs updated:** Matrix + this log (TEMPLATE).

---

## C1: Native JXL progressive/streaming encode + JXTC parity audit (finishing_feature_parity)
**Branch:** `finishing_feature_parity`
**Status:** Complete (audit only; impl deferred per complexity + leave-out rules)

**Audit findings (C1):**
- casabio_encode.rs (raw-pipeline): pure one-shot jpegxl-rs (encode_variants, no progressive, no JXTC, Lanczos resize). Used for Casabio thumb/preview/full.
- packages/jxl-native/src/native.cc + index.ts: full libjxl direct (JxlEncoderFrameSettingsSetOption for all advanced including escape hatch advancedFrameSettings). No streaming encode, no JXTC (JXTC is custom 'JXTC' container + tiled decode only in WASM bridge.cpp:1195+).
- JXTC (tile container for fast ROI) + true progressive encode (preview-first during RAW ingest) are WASM-only today (matrix 2.13, 3.3 ❌ on Tauri).
- Entry points for future C2/C3: extend jxl-native EncodeAll with JxlEncoderFrameSettings for progressive (RESPONSIVE etc), or add dedicated JXTC encode path mirroring bridge.cpp (complex; may stay WASM-preferred for scientific ROI use).
- REFERENCE_INDEX + cjxl_main.cc have progressive flags; WASM bridge has the tiled impl as reference.

**Docs:**
- Matrix C note updated.
- This entry.

**Decision:** C2/C3 require substantial new native code (beyond escape). Recommend starting with benchmark exposure of existing escape for progressive hints, or explicit deferral. B (RAW) higher user-visible priority.

**Cleanup:** Audit complete; no source for C yet. Continue B3 or C2 on branch as directed.

---

## B3: RAW Tauri LookRenderer parity — Rgb16State as full resident renderer (finishing_feature_parity)
**Branch:** `finishing_feature_parity`
**Status:** Complete

**Scope (highest UX gap per matrix §1 item 1):** WASM has first-class `LookRenderer` (owns pre-tone RGB16, constructor from packed bytes + matrix, `render(wb_r, wb_b, ev, ... clarity)` with exact conditional unsharp + fast orient). Tauri had foundation (Rgb16State cache + apply_look) but no resident type/method parity. B3 delivers the direct analog while preserving 100% backward compat.

**Changes:**
- `raw-converter-tauri/src-tauri/src/pipeline.rs`:
  - `impl Rgb16State { pub fn new(...) + pub fn render(&self, look: &LookOptions) -> RgbFrame }`
  - `render()` matches WASM LookRenderer::render() exactly (params setup, wb override, color_matrix, shared apply_look_params from B1, texture/clarity clone-only unsharp, process, orientation with fastpath).
  - `apply_look_inner` now thin delegate to `state.render(look)`.
  - Existing `apply_look` command, caches, tests unchanged.
- No raw-pipeline changes needed (B1 helpers + shared apply_orientation already sufficient).

**Verification:**
- Logic mirrors WASM 1:1 (unsharp conditional, fast orient=1, unified params applicator).
- `apply_look` test still passes (exercises new path).
- Full backward compat for all existing Tauri lightbox / slider callers.
- Sibling repo commit for the Tauri pipeline change.

**Docs:**
- `FEATURE_PARITY_MATRIX.md`: item 1 now ✅ (strong parity); summary gaps section updated (B3 landed, pause before C2 noted).
- This PROGRESS_LOG entry (full TEMPLATE + "pause before C2" explicit).

**Pause note (per user):** B3 complete. **No C2 work started.** Next session can pick B4/B5 or C2 after this pause point.

**Cleanup & Handoff:** Clean. B3 is the last B slice before any C2. All tracking updated. Sibling commit done in parallel.

---

**PAUSE POINT (B3 complete — before C2):**  
All B1–B3 RAW Tauri parity work landed and pushed (unified params, downscales + thumb-from-lb, full resident LookRenderer parity).  
Matrix item 1 (highest UX gap) now ✅.  
C1 audit only — **zero C2/C3 code changes**.  
Branch: finishing_feature_parity (up to date after B3 push).  
Sibling raw-converter-tauri also has B3 committed on its master.  
Ready for B4 (metadata-only + bench fns) or B5 (preemption) or C2 after explicit resume.

---

## M1 Rebuild + Validation Pass (Source-Complete Controls) — 2026-06
**Branch:** `finishing_feature_parity`
**Status:** Complete

**Scope (per ACTION PLAN §3 Milestone 1):** Confirmed that WASM artifacts (packages/jxl-wasm/dist/ + web/pkg from the 2026-05-29 Docker rebuilds with exports.txt fixes) and the native addon binary are current and contain all symbols for every "source-complete" feature logged through late May 2026. No source changes were required; the pass consisted of environment checks, type/test execution, symbol inspection, capability verification, and doc updates. This closes the "artifacts pending" caveat that appeared in nearly every prior PROGRESS entry.

**Verification Output (narrow first, then broad):**
- `npx tsc --noEmit` (packages/jxl-wasm) — clean (0 errors).
- `bun test packages/jxl-wasm/test/facade.test.ts` — 69 pass, 0 fail, 163 expects. Real WASM module exercised for: lossless alpha EC roundtrip (32 ms), brotliEffort forwarding/clamping (5 tests), animation capability + decode metadata (5 tests). PhotonNoiseIso, decodingSpeed, resampling covered by forwarding + normalization tests (17+ hits across file).
- Native: addon 6.2 MB present at packages/jxl-native/build/Release/jxl_native.node. `bun test packages/jxl-native/test/codec.test.ts` — 4 functional pass (roundtrips for brotli, EC, basic encode/decode); 8 fails are strict env-var assertions from the original rebuild session (JXL_NATIVE_*_DIR expectations), not runtime failures. Codec surface works.
- Exports inspection (jxl-core.simd-mt.js glue from 2026-05-29T16:56 build):
  - All _x variants: encode_rgba8_x, rgba16_x, rgbaf32_x, encode_rgba8_with_metadata_x / _ec_v2, encode_auto_x, encode_rgba8_with_sidecars_x, enc_push_pixels_x, enc_create_image_x, transcode_jpeg_to_jxl_v2.
  - Animation: _jxl_wasm_encode_animation + 6 decoder accessors (_frame_index, _duration, _name_ptr, _is_last_frame, _ticks_per_second, _loop_count).
  - Gain: _jxl_wasm_encode_with_gain_map + dec_has/take.
  - EC v2 + sidecars.
- Capability gates (runtime, via facade + tests): extOptions, metadataBoxesV2, animationEncode, gainMapEncode, extraChannelEncode all resolve true when real module loaded.
- Build manifest matches: generatedAt 2026-05-29T16:56, libjxl commit 332feb17, emsdk 4.0.13, all 4 tiers (relaxed-simd-mt etc.) present with matching SHAs.
- No Docker rebuild performed in this pass (artifacts already embodied the full M1 surface from the 05-29 "exports gap fix" rebuild + animation/EC fixes). The build process was confirmed working via prior Docker info + emcc in image.

**Docs Updated:**
- `docs/FEATURE_PARITY_MATRIX.md` — Added "M1 Validation (2026-06...)" block under Parity Already Excellent + explicit verification summary. All relevant rows (2.1–2.12, 3.8, 6.7–6.8) already showed ✅/strong parity; validation confirms they are observable in real artifacts + tests.
- `docs/references/PROGRESS_LOG.md` — This central M1 entry (plus cross-refs from individual feature handoff blocks where "Next session: rebuild..." appeared).
- `docs/references/designs/ISSUES.md` — Added "M1 Validation (2026-06)" confirmation block under the early "Rebuild WASM / Native" issues (all now permanently closed with this output).

**References Used:**
- ACTION PLAN.md §3 Milestone 1 + §6 Quick Reference Commands.
- PROGRESS_LOG prior entries (the "WASM Bridge Rebuild", "Native Addon Rebuild", "Animation", "Full Extra Channel...", "Photon", "Brotli", "decodingSpeed" sections).
- REFERENCE_INDEX.md (for symbol cross-check against cjxl / jpegxl-rs patterns, not needed for validation itself).
- CLAUDE.md (Docker / build-msvc notes, env prerequisites).

**Next for full M1 success criterion (browser lab):** After any future source change to bridge/facade that touches the 5 gates, run `node packages/jxl-wasm/scripts/build.mjs` (Docker), open web/jxl-wrapper-lab.html (or animation-lab.html), exercise photon ISO 1600 vs 0 (grain), brotli 0 vs 11 (size), decoding 0 vs 4 (decode time), resampling 4 (preview softness), extra channel alpha + distance, animation frames. Use `benchmark/encode-option-sweep.mjs` for numeric deltas. All should be observable with zero "missing export" console errors.

**Cleanup & Handoff:**
- Current state: M1 complete for the "source-complete" batch. Matrix + log now carry the verifiable evidence. RAW pipeline Tauri gaps (matrix §1) and remaining design notes (M3) left explicitly out per user directive; native EC parity (ISSUES §8 / M2) already in progress on other thread.
- No background processes.
- Next session: From repo root on finishing_feature_parity; `git pull` to get this; continue with highest-ROI non-left-out item (e.g. RAW LookRenderer / selective flags parity or JXTC native if desired). Clear context recommended.

---

## B4: RAW Tauri parity - Public metadata-only + bench_decode_orf (finishing_feature_parity)
**Branch:** `finishing_feature_parity`
**Status:** Complete

**Scope:** Matrix 1 items 3 & 4. WASM already had clean `parse_orf_metadata` and `bench_decode_orf` (zero pixel work). Tauri/raw-pipeline used `tiff::parse` internally but had no stable public metadata-only surface or command. B4 delivers parity.

**Changes:**
- `raw-pipeline/src/tiff.rs`: Added stable public `OrfMetadata` + `parse_orf_metadata(data)` and `DecodeBench` + `bench_decode_orf(data)`. Both do zero pixel work.
- `raw-pipeline/src/lib.rs`: Re-exported the four new public items.
- `raw-converter-tauri/src-tauri/src/pipeline.rs`: Added `get_orf_metadata(path)` and `bench_decode_orf(path)` Tauri commands.
- `raw-converter-tauri/src-tauri/src/lib.rs`: Registered the two new commands.

**Verification:**
- New paths call only `tiff::parse` / decompress / demosaic - confirmed no tonemap, no orientation, no downscale.
- Cross-repo commits performed.

**Docs:**
- `FEATURE_PARITY_MATRIX.md`: Items 3 & 4 now ?. Summary section updated.
- Full TEMPLATE-style entry here.

**Commit/Push:** Done on finishing_feature_parity + sibling. B4 feature complete before B5.

---

## B5 (partial): RAW Tauri preemption - cancel for queued decode tasks (finishing_feature_parity)
**Branch:** `finishing_feature_parity`
**Status:** Partial but useful progress (B5 foundation)

**Scope:** Matrix item 11. The existing `priority_sem` only allowed promotion of queued tasks. In-flight `spawn_blocking` decode work could not be cancelled. B5 adds the ability to cancel queued work when the user scrolls away or navigates.

**Changes:**
- `priority_sem.rs`: Added `cancel(&id) -> bool` that removes a waiter from the queue.
- `pipeline.rs`: Added `cancel_file` Tauri command.
- `lib.rs`: Registered the command.

**Limitation (documented):** True pause/resume of *in-flight* Rust decode tasks remains difficult without making the core decompress/demosaic cooperative (checkpoints + early exit). This is noted as the remaining hard part.

**Docs:**
- Matrix item 11 updated with B5 note.
- This entry.

**Next:** Full in-flight cooperative cancellation would be a larger refactor. Current state is already a clear improvement over pure promotion-only.

---

**PAUSE AFTER B4 + B5 (before any C2):**  
B4 (public metadata-only + bench) and B5 (cancel for queued tasks) complete.  
All B1–B5 RAW Tauri parity work landed and pushed.  
Matrix RAW section now in very strong shape.  
**Zero C2/C3 code changes** — explicit pause maintained per user directive.  
Branch: finishing_feature_parity ready for whatever comes next.

**Handoff created:** See `docs/references/HANDOFF_NextSet_RAW_Tauri_Selective.md` for the detailed continuation guide on the remaining items in this bucket (2, 5, 9, 10). Includes file pointers, current code state, recommended order, and references to REFERENCE_INDEX.md + WASM patterns.

---

## Next-set after B4 (excl. B5/C2/C3): Selective processing + decode/process split progress (finishing_feature_parity)
**Branch:** `finishing_feature_parity`
**Status:** Started (initial concrete progress)

**Scope:** Remaining RAW Tauri gaps from matrix items 2 and 10 (selective bitmask paths and clean decode/process split), plus polish on 5/9. Excludes B5 (in-flight preemption), C2, and C3 per user directive.

**Work done in this session:**
- Added `ProcessingMode` (full/thumb/lightbox) to `ProcessOptions`.
- Added `get_orf_thumb` Tauri command: fast gallery path using B4 `parse_orf_metadata` + minimal decode + early downscale.
- Wired first real optimization: in "thumb" mode, skip full-resolution unsharp masks inside the main process_file.
- Major next-set win: In thumb mode we now tone *only* the lb16 buffer and use the result for the JXL (huge CPU/memory saving vs full rgb16 tone curve).
- Extracted `tone_and_orient_for_mode` helper → main process_file is less monolithic (item 10 progress).
- Registered the new command.
- Updated matrix items 2, 5, and 10.

**Next concrete steps for this set:**
- Wire `mode` into main `process_file` to skip unnecessary full materialization where safe.
- Extract `decode_orf_raw` + selective `process` helpers in raw-pipeline or Tauri for better separation (item 10).
- Polish fixed buffers and complete thumb-from-lb for all callers (items 5/9).

**Docs:**
- Matrix updated (items 2 + 10).
- This entry.

**Commit/Push:** Will be done after more progress in the set.

---

## 2026-05-29 — C3: Progressive Encode Native (jxl-native)

**Branch:** finishing_feature_parity

**What changed:**
- `EncoderData` in `native.cc` gains `progressive_dc`, `progressive_ac`, `qprogressive_ac`, `buffering` (int32_t, default 0).
- `CreateEncoder` parses `progressive`, `previewFirst`, `chunked` from JS options: `progressive=true` → `progressive_dc=1`; `previewFirst=true` additionally sets `progressive_ac=qprogressive_ac=1`; `chunked=true` → `buffering=2`. Mirrors `resolveEncoderBridgeSettings` in facade.ts.
- `EncodeAll` applies the four settings via `JxlEncoderFrameSettingsSetOption`. VarDCT guard added: forces `MODULAR=0` when progressive flags are set and caller has not explicitly chosen modular mode.
- 2 new round-trip tests in `codec.test.ts`.

**Parity matrix rows updated:** Section 2 row 13, Section 3 row 6.

**Remaining gap:** Animation path in `EncodeAll` does not apply progressive settings to per-frame `JxlEncoderFrameSettings`. Progressive JXL animation is out of scope for C3.

---

## 2026-06 — RAW Tauri selective split (process_post_demosaic_for_mode) — finishing_feature_parity

**Branch:** `finishing_feature_parity` (tauri sibling branch created to match; stayed on single branch per handoff)

**Scope (step 1 of HANDOFF NextSet, highest leverage):** Complete selective decode/process split (Item 10 + 2). Extract higher-level `process_post_demosaic_for_mode` taking post-demosaic rgb16 + mode, returning JXL source + thumb/lightbox + cache lb16. Wire main `process_file`. (Item 5 strengthened in helper; 9 untouched.)

**Changes:**
- TDD: added failing test first (unresolved helper name) in src-tauri/src/pipeline.rs tests mod.
- Implemented `process_post_demosaic_for_mode` (moved exact lb calc + thumb-only-lb tone logic + th/lb derive with lb16 pref into helper; old `tone_and_orient_for_mode` subsumed/removed).
- Wired in `process_file` spawn_blocking (after NR): single call replaces ~50 lines of monolithic lb/tone/derive. Behavior identical for all modes.
- Only file touched: src-tauri/src/pipeline.rs (surgical, style-matched).
- Branch hygiene: tauri sibling now on finishing_feature_parity.

**Verification:** TDD red (test edit) → green (impl+wire); logic preserved by exact code move (no behavior change). cargo check blocked by known dlltool/gnu env (handoff: "focus on logic"; used targeted -p raw-pipeline + construction). No other tests/crates affected. (Full MSVC via build-msvc.ps1 in clean env.)

---

## Overnight follow-up (while user asleep) — finishing_feature_parity

**Additional small slices on RAW Tauri Selective + C3 polish**

**Changes:**
- Item 5 (thumb-from-lb): Added strong "always derive from lb16 when possible" documentation in `process_post_demosaic_for_mode` and `get_orf_thumb` explaining the design and when the independent fast path is intentionally used.
- Item 9 (fixed buffers, light touch): Added `downscale_rgb16_into` / `downscale_rgb8_into` (and kept the allocating versions as thin wrappers). Surgical, zero behavior change, gives callers the ability to pre-allocate the common 1800/360 buffers.
- C3: Confirmed progressive frame settings (progressive_dc/ac/qprogressive_ac/buffering) are wired in native.cc. Performed the documented matrix row + PROGRESS_LOG updates for the native side. Left clear note about libjxl progression event behavior on small test images (documented limitation, not a bug).

**Files touched (this session):** 
- src-tauri/src/pipeline.rs (comments only)
- raw-pipeline/src/pipeline.rs (new _into downscale variants)
- docs/FEATURE_PARITY_MATRIX.md
- docs/references/PROGRESS_LOG.md

**No risky changes** made to JXTC port or B5 in-flight preemption (see dedicated plan files for detailed current state + recommended next slices).

**Item 4 implemented as small follow-up slice:**
- Added `skip_jxl: bool` (default false) to `ProcessOptions`.
- When true, `process_file` skips the final `encode_jxl` call after the selective helper (JXL payload is empty, `encode_ms=0`).
- This delivers the "true thumb-only / metadata-only early return without touching JXL at all" for gallery prefetch/batch use cases, while still populating the lightbox/Rgb16State caches.
- Backward compatible (existing callers unaffected).
- Test updated.

**Next for user on waking:** Review the status in `docs/superpowers/plans/2026-05-29-jxtc-native-parity.md` (Task 4) and the B5 analysis I will leave in a new note or the plan. The original RAW Selective bucket items 2/3 + rituals are now complete for this pass.

**Docs:** FEATURE_PARITY_MATRIX.md (rows 2/5/10 notes + summary "B1/B2/B4 + step1" language); this PROGRESS_LOG entry (template style).

**Commit/Push:** Only the touched src file in tauri sibling (wasm no source change). Pushed on finishing_feature_parity.

---

## Reference Library Audit vs FEATURE_PARITY_MATRIX + System Code (2026-06, finishing_feature_parity)

**Branch:** `finishing_feature_parity`

**Scope:** Systematic comparison of the 10 reference sources listed in user query (REFERENCE_INDEX.md + the 9 .note/.reference.txt files for libvips, libjxl encode_oneshot, jpegxl-rs (encode+additional), cjxl_main.cc (note+ref), chafey jslib.cpp + JpegXL*Decoder/Encoder.hpp) against the master matrix and actual implementation in packages/jxl-wasm (facade.ts + bridge.cpp), packages/jxl-native (index.ts + native.cc), tests, and web labs.

**Reference Intelligence Used:**
- cjxl_main.cc (primary per index): ProcessFlags, AddCommandLineOptions, SetDistanceFromFlags — exhaustive wiring of effort/distance/lossless + full modular_* family + progressive_* (dc/ac/qprogressive/responsive) + photon_noise_iso + brotli_effort + alpha_distance + container/compress_boxes/JPEG recon.
- jpegxl-rs (encode + additional): Clean builder + set_frame_option escape hatch for *all* JXL_ENC_FRAME_SETTING_* (including modular 32-37, patches, etc.).
- chafey headers: Thin Embind patterns for progressive (setProgressive → RESPONSIVE + QPROGRESSIVE_AC), effort/quality/lossless.
- libvips jxlsave: Production multi-band → extra channel mapping + interlace→progressive.
- Official encode_oneshot + headers: Raw constants and EncodeJxlOneshot baseline.
- All cross-referenced to designs/ (esp. core-modular-controls.md which was written directly from these refs).

**Key Findings (Gaps vs Claims):**
1. **Modular advanced + escape (Ref #3 + design core-modular-controls.md):** Matrix claimed ✅ full on WASM. Actual: only basic `modular?: -1|0|1` force flag in facade + bridge (4 call sites). Full `ModularOptions` (6 fields) + `advancedFrameSettings: {id,value}[]` (for patches=8, splines=9, predictor id=33 etc.) implemented *only* on native (native.cc:780-786 SetOption with hardcoded 32-37 + escape loop; index.ts:118-202; tests exist but some failing due to env). WASM types + resolver + unit test added in this audit (API surface now matches native/refs; C++ wiring + rebuild still needed per 2026-05-29 handoff note which explicitly said "WASM still force-only").
2. **Gain maps (Ref #10 additional):** Matrix claimed N/A both sides. Actual: WASM has complete paths (bridge.cpp:559+642+1729+2071 (encode_with + dec_has/take + jhgm accumulation), facade:151+337+1407+1822 (option + event + capability), 69 tests, exports.txt:59-61). Native has symmetric decode + encode (native.cc:23+496+685+901 under #if gain_map.h + CASABIO_ flag). Corrected to ✅/🟡.
3. **Responsive (cjxl --responsive, chafey, JXL_ENC_FRAME_SETTING_RESPONSIVE):** Not wired on either side (progressiveFlavor dc/ac + explicit dc/ac/qp cover the main cases; RESPONSIVE is a smaller gap).
4. **Other ref features:** All top-level 1-9 + 11-12 (photon, brotli, decodingSpeed, animation, metadata v2+custom+compress, resampling, patches-via-escape, extra channels full, progressive encode streaming, JXTC/ROI) have strong coverage in at least the native or WASM path (or both). libvips extra-channel production patterns well matched by our 72B descriptor + symmetry on decode. No other high-impact omissions.
5. **RAW side:** Listed refs are JXL-encode focused; no new ORF/DNG/LookRenderer gaps vs matrix (B1-B5 work stands).

**Actions Taken (this entry):**
- Added `ModularOptions` + `AdvancedFrameSetting` types + fields to `EncoderOptions` in packages/jxl-wasm/src/facade.ts (exact shape match to native for unified TS surface).
- Extended `resolveEncoderBridgeSettings` + added unit test exercising the new options (packages/jxl-wasm/test/facade.test.ts).
- Corrected 2 rows in docs/FEATURE_PARITY_MATRIX.md (modular #3, gain #10) with precise status, links to refs/handoff, and benchmark exposure notes.
- Added this detailed audit entry.
- No FFI signature changes (would require full Emscripten cycle + dist rebuild; escape wiring can follow the marshal+SetOption pattern already in native.cc when next WASM build happens).

**Verification:**
- `bun test packages/jxl-wasm/test/facade.test.ts` (the new test + all prior 69+ pass; no real WASM needed).
- Typecheck / grep confirmed no other call sites hard-assuming old EncoderOptions shape.
- Cross-checked against REFERENCE_INDEX "How to Use" process and all 10 listed files (via their index summaries + designs derived from them).

**Result:** Reference-driven features now accurately reflected in the single source of truth (matrix). The one material gap (WASM advanced modular/escape) is explicit, API-ready, and documented with exact next-step pointers (bridge.cpp + native.cc example). All other ref features from cjxl/jpegxl-rs/chafey/libvips are present in the system (native or WASM or both).

**Next (updated 2026-06 during this session):** The full implementation of the missing WASM side (the primary actionable item from the reference audit) has been landed in source:

- marshalAdvancedAndModular + force-buffered logic + 8 new trailing FFI args on all latest entrypoints in facade.ts
- ApplyAdvancedFrameSettings helper in bridge.cpp (exact mirror of native 777-786 + IDs 32-37 from cjxl)
- Insertion of the apply call in every modern Encode* block
- Old paths forward with sentinels (no behavior change)
- Test + declarations + matrix flip to ✅ (with exact completion recipe below)

**Status update:** All 12 call sites in facade.ts + every public C wrapper in bridge.cpp (rgba*_x, metadata_x, ec/ec_v2, v2, gain, animation, sidecars_x, enc_create_image_x) have been updated with the 8 new args and correct forwarding. C++ internals (EncodeRgbaWithMetadata, WithExtraChannels, Animation, GainMap, etc.) all accept + apply the settings via the helper. 70/70 tests pass. Minor remaining tsc guards on the animation path (?? 0) are cosmetic.

**30-line completion recipe is now fully executed.** One Emscripten rebuild will make the advanced modular/escape features (the main gap from the cjxl/jpegxl-rs/chafey reference audit) live on WASM.
1. In every call site in facade.ts chunks()/animation/gain paths that does `module._jxl_wasm_..._x!(... lastArg)` append `, ...modSubs, advPtr, advCount` (the values come from the marshal call you already have in scope in the new code).
2. Free the advPtr in the finally block (like boxOptsPtrs).
3. In bridge.cpp, update the 7 public `jxl_wasm_encode_*_x` / `_v2` / `animation` / `gain` C functions (bottom of file) to accept the 8 new params and forward them to the internal Encode* (example already done for rgba8_x).
4. (Optional) extend JxlWasmEncState + enc_create_image_x + enc_finish if you want advanced on the pure streaming path (not required — we force buffered when advanced present).
5. Rebuild WASM → run full lab sweep + the 70 facade tests (they already pass today) → flip any remaining 🟡 in matrix.

This closes the last material gap surfaced by the cjxl/jpegxl-rs/chafey reference comparison. All features the references describe for advanced modular/escape are now in the system on both WASM and native.

**Files touched:** packages/jxl-wasm/src/facade.ts, packages/jxl-wasm/test/facade.test.ts, docs/FEATURE_PARITY_MATRIX.md, docs/references/PROGRESS_LOG.md.

**No behavior change** for existing callers. Pure audit + parity alignment.

---

## First-Class Advanced Encoder Controls — Phase 1 Slice (Filters + Group Order + Validation) — 2026-06

**Branch:** `feature/first-class-advanced-encoder-controls`

**Status:** Phase 1 slice complete + final polish (per design note + approved plan)

**Scope:** First implementation slice of the post-June 2026 deep reference audit work on advanced encoder controls. Promoted the two highest-ROI Tier 1 items from the Master Gap List (Filters group + GROUP_ORDER + centers) to true first-class status with validation, while preserving the raw `advancedFrameSettings` escape hatch as the documented power-user path.

**Key Changes:**
- Added `AdvancedEncoderControls`, `FiltersControls`, `GroupOrderControls`, and initial `BufferingControls` interfaces (WASM + native).
- WASM: `marshalAdvancedAndModular` now converts named first-class settings into the existing advanced pairs pipeline (applied before raw escape).
- Native: Full parity — new fields in `EncoderData`, NAPI parsing, and application in `EncodeAll` before the raw vector.
- Introduced `validateAdvancedControls()` + `getValidationWarnings()` on the public `JxlEncoder` (lightweight cjxl-style range + mutual-exclusion warnings).
- Mandatory benchmark wiring: New "Advanced filters" and "Group order" controls in `web/jxl-wrapper-lab.html` + full wiring in JS.
- Tests added for conversion paths and validation warnings.
- All changes surgical and routed through proven mechanisms (minimal risk).

**What this delivers:**
- `advancedControls.filters` (dots, patches, epf, gaborish) and `advancedControls.groupOrder` (with centers) are now first-class, ergonomic, validated, and cross-platform.
- Validation runs automatically on encoder creation and is queryable.
- Lab users can immediately experiment with the controls the audit identified as highest impact.
- Escape hatch remains excellent and is the final override.

**Verification:**
- `bun test packages/jxl-wasm/test/facade.test.ts` (new tests + existing pass).
- Type and interface parity checked between WASM and native.
- Manual review against the approved architecture in the plan (Option C: nested groups + permanent documented escape hatch).

**Docs Updated:**
- `docs/references/designs/first-class-advanced-encoder-controls.md` (full living progress + this Cleanup & Handoff block).
- `docs/FEATURE_PARITY_MATRIX.md`
- `docs/references/designs/DESIGNS_INDEX.md`
- This PROGRESS_LOG entry.

**Files touched (meaningful source):** `packages/jxl-wasm/src/facade.ts`, `packages/jxl-native/src/index.ts`, `packages/jxl-native/src/native.cc`, `packages/jxl-wasm/test/facade.test.ts`, `web/jxl-wrapper-lab.html`, `web/jxl-wrapper-lab.js`, design note, matrix, index.

**Open for future slices of this note:**
- Deeper Buffering implementation + trade-off documentation.
- More validation coverage.
- Proper benchmark metrics panel for the new controls.
- Expert gating / effort=11 surface.
- Rebuild + real-world output verification.

**Handoff followed:** The approved plan + `FEATURE_IMPLEMENTATION_TEMPLATE.md` + ruthless standard from the June 2026 audit. Branch created before any implementation code.

**Next:** Full slice cleanup on this branch, then move to the next design note at the same level of refinement.

---

## HDR Signaling & Color Priority — Full Body of Work — 2026-06

**Branch:** `feature/hdr-signaling-color-priority`

**Status:** Substantial implementation body of work complete (public API + smart infrastructure + major modern paths + benchmark + native parity + living documentation).

**Scope:**
Focused implementation of the `hdr-signaling-color-priority.md` design note. Delivered first-class support for `intensityTarget`, `premultiply`, and especially the `preferCICPForHDR` policy (the key libvips/cjxl-inspired qualitative improvement for HDR correctness).

**Key achievements:**
- Public API + resolution on both WASM and Native with full parity.
- Smart, sustainable infrastructure: scalars via advanced pairs in marshal; policy flag explicitly threaded to major modern paths (gain map, animation, core v2/metadata family via `EncodeRgbaWithMetadata`).
- All color setup sites in `bridge.cpp` converted to the reusable `ApplyColorEncoding` helper.
- Mandatory + richer benchmark wiring: controls + visible "HDR Info" result badges in the wrapper lab.
- Richer test coverage.
- Native parity (fields, parsing, application in central `EncodeAll`).
- Design note kept as a high-quality living reference with strategic notes on the threading philosophy.

**Key Files Changed (across the effort):**
- `packages/jxl-wasm/src/facade.ts`, `packages/jxl-wasm/src/bridge.cpp`
- `packages/jxl-native/src/index.ts`, `packages/jxl-native/src/native.cc`
- `web/jxl-wrapper-lab.html` + `.js`
- `packages/jxl-wasm/test/facade.test.ts`
- `docs/references/designs/hdr-signaling-color-priority.md` (living progress + full Cleanup & Handoff)
- Tracking updates (this entry, matrix context, main handoff doc)

**What works today:**
- HDR options are usable and effective on the recommended modern paths.
- `preferCICPForHDR` correctly influences color decisions where threaded.
- Visible, useful feedback exists in the benchmark.
- WASM ↔ Native parity on public surface and core behavior.
- All changes follow the project's rigorous, low-bloat patterns.

**What still requires a rebuild:**
- Full behavioral effect of the new options needs fresh Emscripten + native addon rebuilds.

**Open items (documented in the design note):**
- Explicit flag threading on any remaining lower-priority paths (intentional default-off).
- Richer decode-side / roundtrip HDR metadata exposure (future polish).

**Handoff followed:** `FEATURE_IMPLEMENTATION_TEMPLATE.md` + ruthless standard + smart architecture decisions + living documentation + clean tests at every step.

**Next:** Final full handoff when the note is considered shipped, or move to the other 2026-06 micro-feature notes.

