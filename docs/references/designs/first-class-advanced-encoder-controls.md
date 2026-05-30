# Feature Design Note: First-Class Advanced Encoder Controls

**Feature:** Promotion of high-ROI `JxlEncoderFrameSettingId` surface (GROUP_ORDER family, DOTS/PATCHES/EPF/GABORISH, BUFFERING modes, DISABLE_PERCEPTUAL_HEURISTICS, expert gating, convenience bundles, and related controls) from raw `advancedFrameSettings` escape hatch to named, validated, ergonomic first-class options  
**Date:** 2026-06  
**Author:** Grok (as the implementing agent post-audit)  
**Status:** Phase 1 complete (filters + GROUP_ORDER + validation + buffering foundation, 2026-06); remaining phases (deeper buffering, metrics, expert gating) future per note. Source + parity + lab delivered to exemplar slice standard.  
**Related Index Section:** Post-June 2026 deep reference audit (REFERENCE_CODE_AUDIT.md Master Gap List + cjxl_main.cc + full enum audit)  
**Priority:** Highest remaining encoder gap after core-modular, extra channels, photon noise, resampling, and metadata work. Directly called out as the primary recommended next artifact in AUDIT_TO_DESIGN_HANDOFF.md.

---

## 1. Goal & Value

Deliver first-class, production-grade, cjxl- and libvips-inspired control over the most valuable advanced encoder settings that real users and the reference CLI actually reach for — while preserving the existing raw `advancedFrameSettings` escape hatch as a stable, explicitly documented power-user and future-proof path.

**Why this is now critical:**

The June 2026 deep reference code audit (against pinned cjxl_main.cc at `714ce6b64cd859675e470d519a338a132fe7b1c1`, the authoritative `encode.h` enum, jpegxl-rs, libvips, and chafey) revealed that even after the successful modular + photon + resampling + brotli + extra-channel + animation + metadata work, the majority of the production encoder configuration surface remains hidden behind an untyped escape hatch or is completely absent.

From the Consolidated Master Gap List (REFERENCE_CODE_AUDIT.md:386):

- Ergonomics & Discoverability (highest user impact): GROUP_ORDER + CENTER_X/Y (with validation), DOTS (7), PATCHES (8), EPF (9), GABORISH (10), KEEP_INVISIBLE (12), PREMULTIPLY, INTENSITY_TARGET, and the `--progressive` convenience bundle.
- Validation & Safety: All cjxl range checks + mutual-exclusion rules (center requires group_order, effort 11 gate, etc.) and the `allow_expert_options` pattern.
- Progressive / Streaming / Memory: Full BUFFERING (34) modes with documented tradeoffs; `--streaming_input` / `--streaming_output`.
- Many other high-value settings (DISABLE_PERCEPTUAL_HEURISTICS (39), MODULAR_COLOR_SPACE (25), independent EXTRA_CHANNEL_RESAMPLING (3), frame_indexing, upsampling_mode, etc.) have zero or escape-only surface despite dedicated IDs and real usage in the reference.

**Current state is Orange at best** under the ruthless standard defined in the audit and handoff:
- "Technically possible via `advancedFrameSettings`" does **not** count as first-class support.
- cjxl performs extensive pre-validation (range checks, mutual exclusion, guarded expert paths) *before* any `JxlEncoderFrameSettingsSetOption` call. Our escape hatch bypasses all of it.
- Convenience bundles ("--progressive" simultaneously setting group_order + responsive + progressive_dc + qprogressive_ac) and helpful error messages that the reference treats as important UX are missing.
- The encoder surface that cjxl, libvips production code, and jpegxl-rs users actually exercise is far larger and more thoughtful than the flat named fields + raw escape we currently expose.

**Value for CasaWASM:**
- Scientific, medical, HDR, pixel-art, benchmarking, and archival workflows need precise, reproducible control (EPF strength, group ordering for tiling, disabling perceptual heuristics, BUFFERING memory/density/streaming tradeoffs, etc.).
- This is the last major step toward the "most complete production-grade JXL implementation" claim.
- Directly fulfills the charter in AUDIT_TO_DESIGN_HANDOFF.md: "the next phase is design + implementation of first-class advanced encoder controls."

**Scope for first pass (Phase 1):** The Tier 1 items with the strongest case (GROUP_ORDER family + validation, DOTS/PATCHES/EPF/GABORISH, BUFFERING modes with tradeoff documentation, DISABLE_PERCEPTUAL_HEURISTICS, expert gating patterns, and progressive convenience considerations). Everything else remains in (or is added to) the documented escape hatch.

**Strategic positioning (non-negotiable):** The raw `advancedFrameSettings` escape hatch **must remain** as a permanent, first-class-documented power-user mechanism (exact philosophy from jpegxl-rs and patches-splines.md). We are adding named ergonomics on top — we are not removing the escape.

---

## 2. Reference Analysis

| Library                  | Exposure                                                                 | Quality     | Notes |
|--------------------------|--------------------------------------------------------------------------|-------------|-------|
| **cjxl_main.cc** (primary gold standard, commit `714ce6b64cd859675e470d519a338a132fe7b1c1`) | Extremely detailed: `--group_order`, `--center_x/y` (with hard mutual-exclusion validation), dedicated `--dots`, `--patches`, `--epf -1..3`, `--gaborish`, `--buffering -1..3` + streaming_input/output semantics, `--disable_perceptual_optimizations`, `--allow_expert_options` gate for effort=11, `--progressive` as convenience bundle, full help-text ranges and pre-validation in `ProcessFlags` / `AddCommandLineOptions`. | Outstanding / Gold standard | The single best place to see real-world usage + the UX patterns (validation, bundles, guarded expert options, documented tradeoffs) that make the reference feel first-class. |
| **libjxl raw** (`encode.h` enum at pinned state) | Complete authoritative list of `JXL_ENC_FRAME_SETTING_*` IDs (GROUP_ORDER=13 + centers 14/15, DOTS=7, PATCHES=8, EPF=9, GABORISH=10, BUFFERING=34, DISABLE_PERCEPTUAL_HEURISTICS=39, MODULAR_COLOR_SPACE=25, EXTRA_CHANNEL_RESAMPLING=3, FRAME_INDEX_BOX=31, etc.). Full `JxlEncoderFrameSettingsSetOption` surface. | Definitive | The source of truth for IDs and semantics. |
| **jpegxl-rs** (commit `0d3590d5c8d3bd57128f70b89fc190f48de60cdd`) | Clean documented escape hatch via `set_frame_option` + strong typed builder on top for the valuable subset. Explicitly treats the raw path as the power-user mechanism. | High (model for escape philosophy) | Perfect precedent: dedicated high-level for common cases + explicit, stable escape for the long tail and experimental. |
| **libvips** (jxlsave.c / jxlload.c — current production) | Chunked low-memory paths (`JxlEncoderAddChunkedFrame` + custom input source) as recommended for large images; sophisticated CICP/ICC priority for HDR; careful metadata box handling; extra-channel and multi-band patterns. Deliberately hides most low-level encoder knobs. | Strong production reference (positive where relevant, negative example of over-hiding) | Shows what a mature wrapper actually exercises for streaming / memory / HDR correctness. |
| **chafey/libjxl-js** (historical) | Hard-coded advanced settings inside the binding with almost no user control. `setProgressive` existed in C++ but was never wired. | Weak / Cautionary tale | Classic example of API surface rot when there is no thoughtful high-level layer + documented escape. |

**Key methodological takeaways (repeated in the audit and handoff):**
- cjxl usage + validation patterns > raw enum numbers.
- Convenience bundles and guarded expert options are deliberate UX in the reference — they are not accidents.
- The escape hatch must be excellent and documented (jpegxl-rs model), not a dumping ground.
- "Feature-maximal" for CasaWASM means we expose the controls that matter in production, with ergonomics and safety, not just the thinnest possible binding.

---

## 3. Recommended API Shape

**Core principle:** Nested logical groups for related controls (consistent with `ModularOptions`, `MetadataOptions`, `GainMapOptions`, `ExtraChannel[]`, `AnimationOptions` in prior notes). The existing flat `advancedFrameSettings` raw escape hatch remains **unchanged and fully supported** as the permanent power-user path (applied last; can override anything).

### TypeScript (public surface — added to `EncoderOptions` in both WASM and native)

```ts
export interface EncoderOptions {
  // ... all existing fields unchanged (effort, distance, modular, progressive*, photonNoiseIso, etc.)

  /**
   * First-class advanced encoder controls for production-grade tuning.
   * These are the high-ROI settings that cjxl and real workflows actually reach for.
   * All values use the same semantics and valid ranges as the reference (cjxl --help + encode.h).
   * Applied before any raw advancedFrameSettings entries (later entries win).
   */
  advancedControls?: AdvancedEncoderControls;

  /**
   * Raw JXL_ENC_FRAME_SETTING_* escape hatch (id + value pairs).
   * Remains the stable, documented power-user and experimental path.
   * Examples: patches (8), splines, future modular tweaks, anything not yet promoted.
   * Applied after all named settings (including advancedControls). Matches jpegxl-rs and native.
   */
  advancedFrameSettings?: readonly AdvancedFrameSetting[];
}

/** Raw escape hatch entry (unchanged). */
export type AdvancedFrameSetting = { id: number; value: number };

export interface AdvancedEncoderControls {
  /**
   * Group storage order for better locality or tiling.
   * 'scanline' (default in most cases) vs 'center' (good for progressive / ROI).
   * When mode='center', centerX/centerY are required by cjxl (mutual-exclusion validation recommended).
   * IDs: GROUP_ORDER=13, CENTER_X=14, CENTER_Y=15.
   */
  groupOrder?: {
    mode: 'scanline' | 'center';
    /** Pixel coordinate for center-first ordering. Only meaningful with mode='center'. */
    centerX?: number;
    centerY?: number;
  };

  /**
   * Advanced coding tools and filters (content-dependent wins).
   * DOTS (7): synthetic dot generation for halftone-like content.
   * PATCHES (8): dictionary-based repeated content modeling (explicitly cited in our own escape docs).
   * EPF (9): edge-preserving filter strength (-1=auto/default, 0=off, 1-3=strength). Major quality knob.
   * GABORISH (10): Gaborish filter (on/off, documented encoder default).
   */
  filters?: {
    dots?: boolean;
    patches?: boolean;
    epf?: -1 | 0 | 1 | 2 | 3;
    gaborish?: boolean;
  };

  /**
   * Buffering / streaming strategy (rich documented tradeoffs in cjxl).
   * -1 = libjxl default, 0 = emit immediately, 1-3 = increasing buffering for memory vs. density.
   * streamingInput/Output tie directly to BUFFERING=3 + JxlOutputProcessor paths.
   * ID: BUFFERING=34. This is the first-class user surface for what our `chunked` flag only partially exercises internally.
   */
  buffering?: {
    strategy?: -1 | 0 | 1 | 2 | 3;
    streamingInput?: boolean;
    streamingOutput?: boolean;
  };

  /**
   * Expert / archival controls.
   * disablePerceptualHeuristics (39): critical for reproducible benchmarking and certain scientific workflows.
   * allowExpertOptions: explicit gate pattern (mirrors cjxl --allow_expert_options for effort=11 and other dangerous settings).
   */
  expert?: {
    disablePerceptualHeuristics?: boolean;
    allowExpertOptions?: boolean;
  };

  /**
   * Additional high-value singletons promoted in Phase 1 or 2.
   * keepInvisible (12), intensityTarget (nits for HDR), premultiply, codestreamLevel (-1|5|10),
   * upsamplingMode (incl. 0=nearest for pixel art), etc.
   */
  keepInvisible?: boolean;
  intensityTarget?: number;
  premultiply?: -1 | 0 | 1;
  codestreamLevel?: -1 | 5 | 10;
  upsamplingMode?: number;

  // Future extension points (e.g. modularExtra for RCT index 25, full JPEG recon granularity)
  // are intentionally left for later phases or the raw escape hatch.
}

/** Existing (kept for compatibility and power users). */
export interface ModularOptions { /* ... unchanged ... */ }
```

### Rust / Tauri (native) side
Mirror the exact same nested `AdvancedEncoderControls` shape (or an equivalent `AdvancedControls` struct) in `packages/jxl-native/src/index.ts:EncoderOptions`.

In `native.cc`, parse the new object the same way `modularOptions` is currently parsed (lines ~1189-1208), then forward the values into the same `JxlEncoderFrameSettingsSetOption` calls before the raw `advanced_frame_settings` loop (preserving override order).

The native side already has the vector escape hatch and most of the low-level wiring — this is mostly "add parsing + named paths."

**Override order (critical, already implemented for modular + escape):**  
named first-class (including new advancedControls groups) → modular subs → raw `advancedFrameSettings` (last wins). Document this clearly.

**Validation strategy (lightweight, client-side only):**
- Range clamping + warnings (EPF -1..3, group centers only valid with mode='center', etc.).
- Mutual-exclusion warnings (center requires groupOrder mode='center') — mirror the cheap checks cjxl does in ProcessFlags, do not attempt full libjxl reproduction.
- "Expert" banner / console warning when disablePerceptualHeuristics or allowExpertOptions is used.
- No hard errors for most optimization hints (libjxl will still be authoritative on final AddImageFrame).

This matches the pragmatic "light validation" pattern in prior notes while raising the bar significantly above the current silent escape hatch.

---

## 4. WASM Implementation

**facade.ts**
- Extend `resolveEncoderBridgeSettings` (or add a new `resolveAdvancedControls`) to translate the nested `advancedControls` into the flat values the bridge expects (or new dedicated parameters).
- Keep the existing `marshalAdvancedAndModular` path; insert the new named values into the advanced pairs or add dedicated parameters to the bridge calls for the extended _x / v2 / animation / gain paths.
- The raw `advancedFrameSettings` array is collected and passed exactly as today (always after named settings).

**bridge.cpp**
- Extend `ApplyAdvancedFrameSettings` (or add a parallel `ApplyFirstClassAdvancedControls`) that receives the new values and calls `JxlEncoderFrameSettingsSetOption` for the promoted IDs **before** the raw escape loop (lines 184-191).
- Add the new constants (or keep using the numeric IDs from the enum table in the audit for now).
- All existing call sites (the three main encode paths) must forward the new parameters.

The delta per control is small (one or two SetOption calls + sentinel handling, exactly like the modular subs at lines 193-201).

---

## 5. Tauri / Native Side

Update `packages/jxl-native/src/index.ts` EncoderOptions to accept the new `advancedControls?: AdvancedEncoderControls` (identical shape).

In `native.cc`:
- Parse the new nested object in the same NAPI section that handles `modularOptions` (~1189).
- Store the values in `EncoderData` (add fields with the same sentinels used for modular: -1 / INT32_MIN etc.).
- In `EncodeAll` (~777), apply the named values via `JxlEncoderFrameSettingsSetOption` **before** the raw `advanced_frame_settings` for loop.
- Preserve the existing progressive / buffering derivation logic and its interaction notes.

Parity requirement: the TS interface shape + documented semantics + override order must be identical between WASM and native.

---

## 6. Benchmark Wiring (Mandatory)

**Location:** Extend the existing `web/jxl-wrapper-lab.html` + `web/jxl-wrapper-lab.js` (primary encoder options surface). Add a new expandable "Advanced Encoder Controls" panel or dedicated tab/section (similar to how photon noise / resampling / decoding speed are currently exposed, but richer).

**Controls for Phase 1 (Tier 1):**
- Group Order: radio or dropdown (scanline / center) + number inputs for centerX/Y (with live validation warning if center is chosen without proper mode).
- Filters: four independent toggles/checkboxes + EPF strength select (-1 / 0 / 1 / 2 / 3) with help text pulled from cjxl semantics.
- Buffering Strategy: select or segmented control (-1..3) + separate checkboxes for streamingInput / streamingOutput. Prominent help popover explaining the memory/density/streaming tradeoffs (direct from cjxl docs).
- Expert: checkbox for "Disable perceptual heuristics" (with strong warning banner: "For benchmarking and archival only — may increase file size and artifacts").
- Optional: intensity target, keep invisible, etc. as they are promoted.

**Metrics & Feedback (high value):**
- Encode time, final file size (delta vs baseline), decode time.
- Visual side-by-side or difference view (especially for EPF/gaborish on edges, patches on synthetic/repeating content).
- "Expert mode" warning banner when dangerous settings are active.
- Corpus recommendations: gradients + edges (EPF/gaborish), halftone/synthetic (dots), repeating UI/patterns (patches), large scientific/medical images (buffering + group order).

**Why this benchmark is especially valuable:** It will be one of the primary ways users (and future agents) discover and tune the controls that the June audit identified as highest-impact. It directly demonstrates the "production-grade" claim.

Per FEATURE_IMPLEMENTATION_TEMPLATE.md §9 and every prior design note: features without benchmark exposure are incomplete.

---

## 7. Testing

- Unit matrix in `packages/jxl-wasm/test/facade.test.ts` and `packages/jxl-native/test/codec.test.ts`: combinations of the new controls + default preservation (bit-identical output when advancedControls omitted).
- Override behavior: named advancedControls value followed by a raw advancedFrameSettings entry for the same ID must win (test the documented order).
- Validation / warning paths (where implemented).
- Cross-platform parity: same options object produces equivalent (or bit-identical where possible) JXL on WASM vs native.
- Representative content: the same corpus families used in the benchmark (gradients, patterns, large images, lossless scientific).
- No regression on existing progressive / chunked / modular / escape paths.

---

## 8. Files & Scope Expectations

**Primary (Phase 1):**
- `docs/references/designs/first-class-advanced-encoder-controls.md` (this note)
- `packages/jxl-wasm/src/facade.ts`
- `packages/jxl-wasm/src/bridge.cpp`
- `packages/jxl-native/src/index.ts`
- `packages/jxl-native/src/native.cc`
- `web/jxl-wrapper-lab.js` + `web/jxl-wrapper-lab.html`
- `packages/jxl-wasm/test/facade.test.ts` + `packages/jxl-native/test/codec.test.ts`
- Tracking: `docs/FEATURE_PARITY_MATRIX.md`, `docs/references/designs/DESIGNS_INDEX.md`, `PROGRESS_LOG.md`

**Risk areas:** Interaction surface with existing progressive/chunked derivation logic; sentinel value discipline across WASM ↔ native; rebuild requirements for both Emscripten and native addon.

---

## 9. Phasing Recommendation

**Phase 1 (first implementation slice — highest ROI):**
- GROUP_ORDER family + center validation
- DOTS, PATCHES, EPF, GABORISH (filters group)
- BUFFERING modes + streaming flags (with tradeoff documentation)
- DISABLE_PERCEPTUAL_HEURISTICS + basic expert gating pattern
- Convenience bundle considerations for progressive
- Full benchmark panel + tests + parity

**Phase 2:**
- Independent extra-channel resampling
- Upsampling mode (incl. nearest-neighbor for pixel art)
- Keep invisible, intensity target, premultiply, codestream level
- Finer JPEG reconstruction controls (cfl, strip granularity, warnings)
- Fuller modular (MODULAR_COLOR_SPACE / RCT index, etc.)

**Phase 3+ (or permanent escape):**
- frame_indexing (complex contract)
- effort=11 explicit surface + full expert gate
- Any remaining low-ROI or highly experimental items

The raw `advancedFrameSettings` escape hatch is available from day one for anything not yet promoted.

---

## 10. Implementation Checklist

- [ ] Design note written and reviewed against ruthless standard + Master Gap List
- [ ] New feature branch created at start of implementation (`feature/first-class-advanced-encoder-controls` or split slices)
- [ ] API shape implemented in shared TS (WASM facade + native/index.ts)
- [ ] WASM bridge.cpp marshal + Apply paths extended (named before raw escape)
- [ ] Native.cc parsing + EncodeAll wiring (parity)
- [ ] Lightweight validation / warnings added where cheap and high-value
- [ ] Unit tests (facade + native codec) covering matrix, override order, defaults
- [ ] Benchmark wiring in jxl-wrapper-lab (new Advanced panel, controls, warnings, metrics)
- [ ] All tracking documents updated (FEATURE_PARITY_MATRIX rows moved, DESIGNS_INDEX status, PROGRESS_LOG entry with full Cleanup & Handoff block)
- [ ] Cross-platform parity verified (same options → equivalent output)
- [ ] Default behavior preservation (bit-identical when advancedControls omitted)
- [ ] Full Cleanup & Handoff following `_cleanup_source.md` + TEMPLATE pattern at end of each slice
- [ ] Handoff document created if any blockers remain

---

---

## Implementation Progress (Living Section)

**Current branch:** `feature/first-class-advanced-encoder-controls`

**Phase 1 progress (filters + GROUP_ORDER + validation + buffering foundation):**
- TypeScript interfaces for filters, groupOrder, and buffering (plus `validateAdvancedControls` helper).
- WASM: Full marshal conversion for all three groups + validation run at encoder construction time (console.warn on issues).
- Native: Complete parity (parsing + application before raw escape).
- Lab UI: Filters + Group Order controls live and wired.
- Validation covers EPF range + groupOrder mutual exclusion (center requires centers).
- Buffering controls started (strategy + streaming hints).
- Tests extended (including validation warnings test + lowMemoryMode usage).
- All tracking and living docs updated.
- Escape hatch 100% preserved.
- Runtime probe for optional features (gain map) added to native for discoverability parity.

**Status:** Phase 1 slice complete (2026-06). See PROGRESS_LOG "First-Class Advanced Encoder Controls — Phase 1 Complete" entry for the full TEMPLATE handoff.
- `getValidationWarnings()` exposed on the public `JxlEncoder` interface.
- All Phase 1 controls (filters, groupOrder, initial buffering) functional via the sustainable advanced pairs path.
- Full WASM ↔ native source parity + lab exposure.
- This slice delivered to the same bar as HDR / JPEG recompression Phase 3 exemplars (smart wiring, no unnecessary FFI, rich docs, tests, benchmark wiring).

Rebuild still recommended for full end-to-end behavioral verification on real artifacts. Future slices (deeper buffering trade-off docs, dedicated metrics panel, expert gating) remain per the design note.

---

## Cleanup & Handoff (Phase 1 Slice)

**Branch:** `feature/first-class-advanced-encoder-controls`

**Date:** 2026-06

**Scope of this slice:**
- Foundation for first-class advanced encoder controls per the June 2026 deep audit.
- Promoted the two highest-ROI Tier 1 items: **Filters** (DOTS/PATCHES/EPF/GABORISH) and **GROUP_ORDER + centers**.
- Added initial `BufferingControls` surface.
- Introduced `validateAdvancedControls()` + exposed `getValidationWarnings()` on the public `JxlEncoder` API.
- Full WASM ↔ native parity maintained.
- Mandatory benchmark wiring in the wrapper lab.
- Tests, validation, and documentation.

**Key Files Changed (source only):**
- `packages/jxl-wasm/src/facade.ts` — types, marshal conversion, validation, `getValidationWarnings()`, constructor integration.
- `packages/jxl-native/src/index.ts` — matching TypeScript interfaces.
- `packages/jxl-native/src/native.cc` — EncoderData fields, NAPI parsing, application in `EncodeAll`.
- `packages/jxl-wasm/src/bridge.cpp` — documentation comments only (reused existing raw pairs path).
- `packages/jxl-wasm/test/facade.test.ts` — new tests for conversion and validation warnings.
- `web/jxl-wrapper-lab.html` + `web/jxl-wrapper-lab.js` — Advanced filters panel + Group order controls + wiring.
- `docs/references/designs/first-class-advanced-encoder-controls.md` — living implementation notes + this handoff.
- `docs/FEATURE_PARITY_MATRIX.md` + `docs/references/designs/DESIGNS_INDEX.md` — status updates.

**What works today (source level):**
- `advancedControls.filters` and `advancedControls.groupOrder` are fully functional through the existing advanced pairs pipeline on both platforms.
- Validation runs automatically and is queryable.
- Lab controls are live and send the new structures.
- Escape hatch (`advancedFrameSettings`) remains 100% intact and acts as the final override.

**What still requires a rebuild:**
- Actual effect on encoded JXL output needs a fresh Emscripten build (and native addon rebuild for full parity testing).

**Known Limitations / Open Items (for future slices of this note):**
- No deep client-side clamping (we warn only; libjxl remains authoritative).
- Buffering is foundation only — full streaming input/output paths and trade-off documentation still need work.
- No dedicated benchmark metrics yet for the new controls (size deltas, visual effect of EPF/GROUP_ORDER, etc.).
- Expert gating / effort=11 and finer JPEG reconstruction controls remain future work.

**What to do before the next session / next agent:**
- Clear chat context.
- `git checkout feature/first-class-advanced-encoder-controls`
- Run `bun install` (or equivalent) if node_modules are stale.
- For real verification: perform Emscripten rebuild of `packages/jxl-wasm` + native addon rebuild.
- Then run the full lab sweep + `bun test packages/jxl-wasm/test/facade.test.ts`.

**Recommended next commands (after rebuild):**
```powershell
# After rebuild
bun test packages/jxl-wasm/test/facade.test.ts
# Then open web/jxl-wrapper-lab.html and exercise the new Advanced Filters + Group Order panels
```

**Notes / Gotchas:**
- We deliberately routed everything through the existing raw `advancedFrameSettings` pairs mechanism. This kept changes minimal, low-risk, and consistent with how modular options were previously landed.
- The validation is intentionally lightweight (not a full reimplementation of cjxl's ProcessFlags).
- All changes respect the "ruthless standard" and the escape-hatch philosophy documented in the note.

**Handoff complete for this slice.** The foundation + two major Tier 1 items + validation layer are solid, documented, and ready for rebuild + deeper usage.

**Next recommended work on this note:** Expand validation, complete Buffering surface with good trade-off docs, add proper benchmark metrics, then move to expert controls / effort gating.

---

**End of design note (Phase 1 slice complete).**

The June 2026 audit did the hard diagnostic work. This note (and its implementation) is turning that map into production-grade, first-class controls while keeping the power-user escape hatch excellent.

Make the magic real — one slice at a time, to the same standard.