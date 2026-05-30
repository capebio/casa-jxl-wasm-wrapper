# Action Plan — Completing JPEG XL Feature Implementations

**Date:** 2026-06 (review performed on epiccodereview/20260527T054853)  
**Source:** Review of `docs/references/PROGRESS_LOG.md` (full file read), cross-checked against:
- Live source (`packages/jxl-wasm/src/{facade.ts,bridge.cpp}`, `packages/jxl-native/src/{index.ts,native.cc}`)
- Tests (`packages/jxl-wasm/test/facade.test.ts`, native codec tests)
- Benchmark wiring (`web/jxl-wrapper-lab.{html,js}`)
- Design notes (`docs/references/designs/*.md` + `DESIGNS_INDEX.md`)
- Build artifacts (`packages/jxl-wasm/dist/build-manifest.json`, `web/pkg/`, `exports.txt`)
- Git history (recent EC Phase 1 commits), `ISSUES.md`, `HANDOFF.md`, `FEATURE_IMPLEMENTATION_TEMPLATE.md`
- CLAUDE.md / project invariants

**Goal of this document:** Convert the historical record in PROGRESS_LOG into a concrete, prioritized, verifiable plan that finishes all claimed implementations and executes the remaining design notes to production-ready state (source + artifacts + parity + tests + benchmark + docs).

---

## 1. Executive Summary of PROGRESS_LOG Implementation Status

PROGRESS_LOG.md is a high-quality chronological journal following the mandated template. Entries are generally accurate about **source changes at the time they were written**. However, "complete" claims must be qualified:

### Source-Complete (WASM + tests + some native + lab wiring)
- Brotli Effort (pre-existing + tests + native + benchmark)
- Metadata Boxes & Container Decisions (v2 paths, custom boxes, compress/force/raw, JPEG recon) — strong WASM, partial native (customBoxes noted "not yet")
- Decoding Speed Tier (0-4)
- Photon Noise (ISO)
- Resampling (1/2/4/8)
- Extra Channel Distance Phase 1 (alphaDistance + basic ExtraChannel descriptors + per-EC distance + dispatch fixes for the other new options) — WASM + tests complete; **native + dedicated benchmark deferred explicitly to Phase 2**

### Claimed on Other Branches / Not Present on Current Epic Branch
- **Patches & Advanced Frame Settings Escape Hatch** (2026-06 entry) — `advancedFrameSettings?: Array<{id,value}>` + `JxlFrameSetting` constants + `_adv` FFI paths. Design checklist partially ticked. Code absent from `facade.ts` / `bridge.cpp` / `jxl-native` on this branch. Work was done in a separate `transpose-wasm-to-tauri` worktree + main. Not merged here.
  - *Post-sync note (2026-06):* The corresponding PROGRESS_LOG entry was qualified with a Visibility Note during the REFERENCE_INDEX.md cross-check pass. The qualification now explicitly points readers to this ACTION PLAN Milestone 3 for resolution. See updated PROGRESS_LOG.md (top sync block + Patches entry).

**Doc Sync Pass (2026-06):** PROGRESS_LOG.md was reviewed and lightly updated against REFERENCE_INDEX.md (feature-to-ref mapping + cjxl_main.cc emphasis). A top-level "Doc Sync with REFERENCE_INDEX.md" block was added mapping logged work to INDEX sections #3–#4, #7–#9, #11. One "References Used" section (Extra Channel Phase 2) now cites the exact INDEX implementation block it authored. These changes make future ACTION PLAN refreshes start from a tighter, cross-referenced historical record. No new implementation claims were added.

### Partial / Stubs + In-Progress Work
- Gain Map encode/decode (C++ `EncodeRgbaWithGainMap` + `#if JXL_GAIN_MAP_SUPPORTED` box path exists; TS wiring + `gainMapEncode` cap exists; depends on libjxl build having symbols)
- **Animation / Multi-Frame — actively in progress** (detailed implementation plan at `docs/superpowers/plans/2026-05-29-animation-multi-frame.md`; recent commits on this branch added `AnimationFrame`/`AnimationOptions` interfaces, `frames?` + `animation?` on EncoderOptions, decode accessor declarations, and `animationEncode` capability gate + FFI declaration. C++ bridge implementation, `exports.txt` entries, native parity, tests, and benchmark page are still pending. Matches the early stages of the superpowers plan.)

### Design-Complete Only (no or minimal source work)
- Core Modular Controls (rich nested: `modular: {force, groupSize, predictor, nbPrevChannels, palette...}` — only the basic `modular?: number` force flag is threaded today via the _x paths)
- Full Extra Channel Infrastructure (Phase 2 per `extra-channel-infrastructure.md`)
- Gain Maps (HDR) — beyond the basic encode stub

**Recurring Caveat in Nearly Every "Implemented in Source" Entry (Accurate):**
> "WASM/browser runtime needs regenerated artifacts before browser can exercise the new C++ exports."
> "Native addon rebuild blocked (Docker / node-gyp missing in environment)."

Last real WASM build (per manifest): **2026-05-28T03:40** — predates the 05-29 EC fixes, many _x / v2 / ec_v2 routings, and recent animation stubs. `web/pkg/` and `packages/jxl-wasm/dist/*.wasm` do not contain the new symbols. All "real runtime" verification is blocked until rebuild.

---

## 2. Systemic Gaps (Root Causes)

1. **Artifact Rebuild is the #1 Blocker** (Docker/Emscripten + native node-gyp). Mentioned in PROGRESS_LOG, ISSUES.md (entries 1-4), every recent handoff.
2. **WASM vs Native Parity Drift** — WASM has received the majority of the recent encoder control work. Native lags on extra channels (Phase 1) and has no advanced escape hatch.
3. **Verification Gap** — Excellent unit tests (mocked modules). Zero end-to-end validation of new C++ paths in real WASM or rebuilt native because artifacts are stale. No visual/metric confirmation in lab for most new tunings.
4. **Process Adherence (Minor)** — Some entries reference work without new feature branches (violates TEMPLATE). Patches entry is on a worktree not visible here. Early Animation TS stubs landed on the epic branch ahead of full plan execution (detailed superpowers plan now exists).
5. **Design Notes Not Yet Executed** — 11 notes written. Several have partial or active source work (Animation is the most advanced of the remaining batch thanks to the dedicated superpowers plan + recent TS commits). Core Modular, full EC Phase 2, Gain Maps, and Patches still have no or minimal implementation.
6. **exports.txt Drift Risk** — Contains `_ec_v2` but many _x variants that the facade capability-gates on are not listed (they are keptalive in C++ and surface via Emscripten glue generation).

---

## 3. Prioritized Action Plan

### Milestone 0: Environment & Tooling (Prerequisite for Everything)
- [x] Start Docker Desktop (or Linux engine) + ensure `docker.io/emscripten/emsdk:4.0.13` is pullable. Verified: `docker info` succeeds; image up to date (2026-05-29).
- [x] Native addon rebuilt (2026-05-29) — `jxl_native.node` 6.2 MB; 6 tests pass. libjxl 0.11.x static `/MT` libs staged to `C:\TEMP\jxl-mt-libs\`. See ISSUES.md §4 + PROGRESS_LOG "Native Addon Rebuild" for full env notes.
- [x] Emscripten Docker build confirmed working — WASM artifacts rebuilt successfully via Docker on 2026-05-29 (build manifest `generatedAt: 2026-05-29T15:43:11.796Z`; all 4 tiers produced). Host-toolchain fallback not needed.
- **Verification:** `docker run --rm docker.io/emscripten/emsdk:4.0.13 emcc --version` succeeds.

**Build note (2026-05-29):** First rebuild also revealed `exports.txt` was missing 10 `_x` and `_v2` symbols (`encode_rgba8_x`, `encode_rgba8_with_metadata_v2`, `encode_auto_x`, `encode_rgba8_with_sidecars_x`, `enc_push_pixels_x`, `enc_create_image_x`, `transcode_jpeg_to_jxl_v2`, and the `rgba16_x`/`rgbaf32_x`/`metadata_x` variants). All added; second rebuild completed — all 5 capability gates (`extOptions`, `metadataBoxesV2`, `animationEncode`, `gainMapEncode`, `extraChannelEncode`) now resolve `true` in browser. 69 facade tests pass.

### Milestone 1: Rebuild + Validate All "Source-Complete" Features (Highest ROI)
Target: Make the controls already in source (brotli, decodingSpeed, photonNoiseIso, resampling, metadata v2, extra-channel Phase 1 basics) actually runnable and observable.

1. **Rebuild WASM artifacts (jxl-wasm)**
   - Run the full build per CLAUDE.md + scripts/build.mjs (Docker preferred for reproducibility).
   - Update `packages/jxl-wasm/dist/build-manifest.json` (it will be regenerated).
   - Decide per ISSUES.md #2: commit the new `dist/*.wasm` + glue or treat as generated-only. Update `.gitignore` / publish config accordingly.
   - **Verification (narrow first):**
     - `npm --workspace packages/jxl-wasm run typecheck`
     - `bun test packages/jxl-wasm/test/facade.test.ts` (already ~all pass via mocks; now also exercise real module if possible)
     - Inspect new `.wasm` with `wasm-objdump` or Emscripten glue for presence of `_jxl_wasm_encode_rgba8_x`, `_jxl_wasm_encode_rgba8_with_metadata_ec_v2`, `jxl_wasm_encode_with_gain_map`, etc.
   - **Verification (broad):**
     - Load in browser via `web/jxl-wrapper-lab.html` (or the progressive pages).
     - Confirm `capabilities.extOptions === true` and `metadataBoxesV2 === true`.
     - Run encode sweeps with the new options and compare file sizes / decode speed (use existing `benchmark/encode-option-sweep.mjs`).

2. **Rebuild + test native addon (jxl-native)**
   - `npm --workspace packages/jxl-native run build` (or the rtk wrapper).
   - Run `packages/jxl-native/test/codec.test.ts` (the brotli roundtrip + add one for resampling or photon).
   - **Parity task (see Milestone 2):** Wire the missing Extra Channel Phase 1 bits into native.cc + index.ts while here.

3. **Update all affected design notes + DESIGNS_INDEX.md + PROGRESS_LOG.md**
   - Mark "Source + artifacts + verified in lab" for the five core controls.
   - Add a "Rebuild Validation" subsection to each relevant PROGRESS_LOG entry.

4. **Close related ISSUES.md entries** (1-4 at minimum) with verification output.

**Success for M1:** A developer can open `web/jxl-wrapper-lab.html` (after rebuild), select photon noise ISO 1600 / decode speed 3 / resampling 4 / compress boxes, encode a gradient or real photo, and observe measurable differences (size, visual grain, decode timing) with no console errors about missing exports.

### Milestone 2: Native Parity & Phase 1 Completion
1. **Extra Channel Distance (Phase 1) — Native side (EC-TAURI-01 per recent ISSUES handoff)**
   - Add `alphaDistance?: number` and `extraChannels?: readonly ExtraChannel[]` (or the WasmExtraChannel-shaped descriptor) + `extraChannelPlanes` to `EncoderOptions` in `packages/jxl-native/src/index.ts`.
   - Extend `EncoderData` struct, parsing in `CreateEncoder`, and the encode path in `native.cc` to call `JxlEncoderSetExtraChannelInfo` + `JxlEncoderSetExtraChannelDistance` + `JxlEncoderAddExtraChannelBuffer`.
   - Add at least one roundtrip test exercising alpha or a simple extra channel.
   - **Verification:** Native test passes + manual encode via the Tauri side (when integrated).

2. **Advanced Frame Settings escape hatch — Native parity** (once the WASM side lands or in parallel)
   - Mirror the `advancedFrameSettings` + `JxlFrameSetting` constants into `jxl-native`.

3. **Custom boxes in native** (explicitly noted as "not yet implemented" in index.ts)
   - Wire `JxlEncoderAddBox` for the `customBoxes` array (after the v2 metadata work).

**Deliverable:** WASM and native have feature parity for everything logged as "Implemented" through 2026-05-29.

### Milestone 3: Execute Remaining Design Notes (in Priority Order)
Follow `FEATURE_IMPLEMENTATION_TEMPLATE.md` + the checklist at the bottom of each design note **exactly** (new branch per feature, benchmark wiring mandatory, full Cleanup & Handoff block, PROGRESS_LOG append, design note status update).

Recommended order (highest leverage / dependencies first):

1. **Core Modular Controls** (`core-modular-controls.md`)
   - Implement the nested `modular: { ... }` shape (or flat with clear naming).
   - Thread groupSize, predictor, nbPrevChannels, palette basics through a new `_modular` or extended _x path (or reuse escape hatch internally).
   - Rich benchmark matrix (predictor x group size) on the lab page.
   - Tests + native parity.

2. **Patches & Advanced Frame Settings** (finish the 2026-06 work + merge or re-execute cleanly on a proper feature branch)
   - Port the escape hatch from the worktree if it exists, or implement fresh per the design note.
   - Add the minimal experimental UI + strong warning in wrapper-lab (as described).
   - Smoke test on synthetic repeating content.
   - Native parity.

3. **Animation / Multi-Frame** (actively in progress — see `docs/superpowers/plans/2026-05-29-animation-multi-frame.md`)
   - Continue from current state (TS interfaces + capability gate done; C++ bridge, exports, full marshal/dispatch, decode event extensions, and native still needed).
   - Follow the superpowers plan file map exactly (new `WasmAnimationFrame` / `WasmAnimationOpts` structs, `EncodeAnimation()`, decoder `JXL_DEC_FRAME` subscription + accessors, etc.).
   - Add `animationEncode` support to the existing encoder paths (or dedicated one-shot path).
   - Decode-side: extend events with `frameIndex`, `duration`, `frameName`, `isLastFrame` (and animation header info).
   - Rich benchmark/demo page (`web/animation-lab.html` per the plan) or integration into existing progressive lab.
   - Native parity (jpegxl-rs animation builders recommended in design).
   - Tests + full handoff. Coordinate with scheduler/session team per design note risk note.

4. **Full Extra Channel Infrastructure (Phase 2)** (`extra-channel-infrastructure.md`)
   - Complete `ExtraChannelType` enum, names, spot color, dimShift, bit depths, decoder symmetry.
   - Update decoder side (currently decoder is thinner on extra channels).
   - Update Tauri side.

5. **Gain Maps (HDR)** (`gain-maps.md`)
   - Finish / harden the existing stub (make the `#if` path reliable, expose `GainMapOptions` cleanly, decoder `takeGainMap`).
   - Leverage existing `LookRenderer` / tone-mapping in the RAW pipeline (`src/lib.rs`).
   - HDR benchmark page or section (tone-mapped vs gain-map assisted).

6. **Lower priority / later:** Any remaining items from the original audit or new ones logged in ISSUES.md.

For each:
- Create feature branch **before any code**.
- Wire benchmark (mandatory per TEMPLATE).
- Add unit + at least one integration/visual smoke.
- Native parity (or explicit deferral with handoff).
- Update all docs + PROGRESS_LOG + DESIGNS_INDEX.

---

## 4. Cross-Cutting / Continuous Actions

- **Rebuild Discipline:** After any bridge.cpp change that adds/renames exports or changes struct layouts (WasmBoxOpts, WasmExtraChannel, etc.), treat "run the WASM build + inspect exports + smoke in lab" as a required verification step before claiming done.
- **Capability Gating:** Keep all new hot paths behind the existing `caps.*` checks (extOptions, metadataBoxesV2, gainMapEncode, animationEncode, ...). Never assume a symbol exists.
- **Test Gaps (from CLAUDE.md decode-handler section + new EC tests):** Add the listed test cases under `packages/jxl-worker-browser/test/` if not already present. Add real-module (post-rebuild) variants of the facade encode-option tests.
- **Documentation:** 
  - Keep `Overview and features of the CasaWASM JXL wrapper.md` in sync.
  - Add "Requires WASM rebuild dated XXX" notes to any public API surface that depends on new exports until the artifacts are committed and versioned.
- **Process:** Update `PROGRESS_LOG.md` only at true completion of a TEMPLATE cycle (including rebuild + lab verification where applicable). Never back-date or claim "complete" for work on invisible worktrees without merge + verification.
- **ISSUES.md Hygiene:** After each milestone, close entries with full reproduction + verification output. Add new entries using the exact "Issue Entry Specification" template at the top of the file.

---

## 5. Success Criteria (Measurable)

- All five "source-complete" controls from 2026-05 logs produce observable, correct effects in a freshly rebuilt browser lab (size deltas, visual grain for photon, decode timing for speed tier, container vs raw output, extra-channel roundtrips including alphaDistance).
- Native codec tests cover the same surface as WASM facade tests for the core controls + extra channel Phase 1.
- `DESIGNS_INDEX.md` shows at least 3 more features moved from "Design complete" to "Implemented on branch X" with links.
- No open entries in ISSUES.md that are older than the current sprint.
- A clean "M3 complete" PROGRESS_LOG entry exists that references successful rebuild + lab validation for the batch.
- New feature work strictly follows the branch + benchmark + handoff + log discipline.

---

## 6. Quick Reference Commands

```powershell
# WASM (after Docker up)
cd packages/jxl-wasm
node scripts/build.mjs --release   # or the full pnpm workspace script

# Native
cd packages/jxl-native
npm install
npm run build   # or npx node-gyp rebuild

# Tests (fast, pre-rebuild)
bun test packages/jxl-wasm/test/facade.test.ts
npm --workspace packages/jxl-native test

# Lab (post-rebuild)
# Open web/jxl-wrapper-lab.html in browser; use the photon / decode-speed / resampling / metadata sections
```

---

## 7. Related Documents

- `PROGRESS_LOG.md` (source of truth for history)
- `docs/references/designs/DESIGNS_INDEX.md` + individual `*.md`
- `docs/references/FEATURE_IMPLEMENTATION_TEMPLATE.md`
- `docs/references/designs/ISSUES.md` (current open handoff items)
- `docs/references/HANDOFF.md` and `Next_Features_Handoff_2026-05-28.md`
- `packages/jxl-wasm/BLOCKED.md` and `STATE.md` (package-specific)
- CLAUDE.md (build commands, invariants, rejected optimizations)

**End of Action Plan.** When executing, start with Milestone 0 + 1. Every step must produce verifiable output before moving on.

---
*Generated from full code + doc review. Update this plan as work progresses; append completion dates and links to commits / new PROGRESS_LOG entries.*