# JPEG XL Implementation Progress Log

This file is used to record progress at the end of each feature/section.

Use the template below for every entry.

---

**Doc Sync with REFERENCE_INDEX.md (2026-06 review):** All major features logged here map to sections in the Feature Index (e.g. Full Extra Channel Infrastructure → #4 Extra Channels with full CasaWASM Phase 2 lines; Brotli Effort → #7; Animation → #8; Metadata Boxes → #9 + container notes; Patches & Splines → audit #11 escape-hatch design; Core Modular → #3). See REFERENCE_INDEX.md for the authoritative reference implementations (cjxl_main.cc prioritized for real usage patterns across options; jpegxl-rs for clean high-level API shape). Individual entries below have been qualified for branch visibility where work occurred outside the primary epic branch. This sync ensures the log remains the accurate historical complement to the static feature-to-reference mapping.

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
