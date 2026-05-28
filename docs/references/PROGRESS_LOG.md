# JPEG XL Implementation Progress Log

This file is used to record progress at the end of each feature/section.

Use the template below for every entry.

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

**Tests:**
- `packages/jxl-wasm/test/facade.test.ts` — added `describe("decodingSpeed encoder option", ...)` with 5 tests covering tier forwarding, -1 default, clamp-to-0, clamp-to-4.
- `bun test packages/jxl-wasm/test/facade.test.ts` — 38 pass, 1 pre-existing unrelated failure.

**Docs Updated:**
- `docs/references/PROGRESS_LOG.md`

**References Used:**
- `docs/references/designs/decoding-speed-tier.md`

**Cleanup & Handoff:**
- Current state: Source implementation complete. WASM/browser runtime needs regenerated artifacts before browser can exercise the new C++ exports.
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
- `packages/jxl-native/test/codec.test.ts` — New test exercises `brotliEffort` at 0/9/11; all 2 tests pass

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
