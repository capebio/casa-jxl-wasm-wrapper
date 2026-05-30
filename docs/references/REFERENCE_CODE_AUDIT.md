# JXL Reference Code Deep Audit (Actual Sources)

**Status:** Core audit phase complete (cjxl_main.cc, encode.h, jpegxl-rs, chafey, libvips) – 2026-06  
**Purpose:** Exhaustive comparison of CasaWASM JXL implementation against the *real* upstream reference code (not just the notes). This document is the primary source material for the "First-class Advanced Encoder Controls" design note.

---

> **⚠️ Important Warning – Seeded Rows**
>
> This file contains pre-filled example rows added as scaffolding.
>
> **You must re-verify every seeded row** against the real pinned source. Do not trust the existing severity ratings.
>
> Start every library section with the **Reproducibility** header block shown in the sections below.

---

**Reproducibility Requirements (from the handoff):**
Every library section must begin with the standardized **Reproducibility** header (commit, fetch method, seeded rows verification status). See the examples below.

**Legend for this document**
- **❌ Red**: Not implemented or major missing capability compared to the reference
- **🟠 Orange**: Needs improvement (partial exposure, only via escape hatch, ergonomics gap, weaker behavior, missing important options or patterns, etc.)
- ✅ : Matches or exceeds the reference in this area (rare in this document)

---

## 1. cjxl_main.cc

**Reproducibility**
- Commit / Revision: `714ce6b64cd859675e470d519a338a132fe7b1c1`
- Fetched via: raw.githubusercontent.com (web_fetch at exact commit)
- Date fetched: 2026-06-13
- Date audited: 2026-06-13

**Seeded rows status:** All pre-existing example rows were re-verified against the pinned source above. Partial — multiple seeded items confirmed as dedicated, validated CLI paths in `AddCommandLineOptions` + `ProcessFlags`. Internal buffering usage exists in our chunked path but no first-class user API.

**Notes on process:**
- Analyzed full `AddCommandLineOptions`, `ProcessFlags`, `ProcessBoolFlag`, `ProcessFlag`, `SetDistanceFromFlags`, and all direct `params->options.emplace_back` + `AddOption` calls at the pinned commit.
- Cross-checked against our `EncoderOptions`, `ModularOptions`, and `advancedFrameSettings` escape hatch in facade.ts:169 and bridge.cpp wiring (both WASM and native paths).
- Ruthless rule applied: anything only reachable via the untyped `advancedFrameSettings` escape hatch (or completely absent) is **Orange at best**. Convenience bundles, range validation, and mutual-exclusion logic in cjxl count as first-class reference behavior we lack.

### Key Observations Not Fully Captured in Prior Notes

- cjxl performs **extensive pre-validation** (range checks, mutual exclusion e.g. `--center_x/y` requires `--group_order=1`, effort 11 gating) *before* any `JxlEncoderFrameSettingsSetOption` call. Our escape hatch bypasses all of it.
- `--progressive` is a **convenience bundle** that simultaneously sets `group_order`, `responsive`, `progressive_dc`, and `qprogressive_ac`. This "good defaults" UX pattern has no equivalent.
- `photon_noise_iso` is the *recommended* path; `--noise` is deprecated in the same binary. We only expose the recommended one (good).
- `BUFFERING` modes have rich, documented semantics (memory vs density vs streaming input/output) that our internal `chunked` handling only partially exercises.
- JPEG reconstruction + strip controls via `dec-hints` are significantly more granular than our `MetadataOptions`.
- Many modular flags carry explicit help-text ranges (e.g. `--modular_colorspace -1..41`, predictor `0..15`) that cjxl validates.

### Reference Patterns Worth Emulating from cjxl

- **Guarded expert options**: `allow_expert_options` is a deliberate gate for effort=11 (extreme cost). Not just "let the user pass any number".
- **Convenience bundles vs raw flags**: `--progressive` exists alongside the individual progressive_* flags.
- **Help-text ranges + validation**: Almost every advanced flag documents its exact accepted range in `--help` and enforces it before calling the C API.
- **Streaming modes are first-class**: `--streaming_input` and `--streaming_output` are explicit, with clear interaction notes to `buffering=3`.
- **JPEG recompression metadata is treated as a first-class concern**: Multiple dedicated controls + warnings about reconstruction compatibility.

### Detailed Findings

| # | Feature / Option / Pattern from Real Code | JXL ID | Reference Location | WASM | Native | Severity | Notes / Action |
|---|-------------------------------------------|--------|--------------------|------|--------|----------|----------------|
| 1 | `GROUP_ORDER` + `GROUP_ORDER_CENTER_X/Y` (with mutual-exclusion validation) | 13, 14, 15 | `ProcessFlags` ~550 + `AddCommandLineOptions` | 🟠 (escape only) | 🟠 | Orange | Dedicated flags + hard validation. First-class typed API + docs strongly recommended. |
| 2 | Dedicated `--dots` | 7 | `ProcessBoolFlag` | 🟠 (escape only) | 🟠 | Orange | No named surface. |
| 3 | Dedicated `--patches` | 8 | `ProcessBoolFlag` | 🟠 (escape only) | 🟠 | Orange | Explicitly cited in our own escape-hatch docs as a primary use case. |
| 4 | `--epf` with -1..3 validation | 9 | `ProcessFlag` | ❌ | ❌ | Orange | Production-important filter strength knob. |
| 5 | `--gaborish` | 10 | `ProcessBoolFlag` | ❌ | ❌ | Orange | Simple on/off with documented encoder default. |
| 6 | `--buffering` (-1..3) + full streaming semantics | 34 | `AddCommandLineOptions`, `ProcessFlag`, streaming_output path | 🟠 (internal only) | 🟠 | Orange | cjxl documents real memory/density/streaming tradeoffs. Our `chunked` hard-codes behavior with no user control. |
| 7 | Fine-grained JPEG strip controls (`strip=exif|xmp|jumbf`) + reconstruction warnings | — | `ProcessFlags` + `color_hints_proxy` stripping logic | 🟠 (coarse only) | 🟠 | Orange | We lack per-metadata-type strip + the compatibility warnings cjxl emits. |
| 8 | `--already_downsampled` + `--upsampling_mode` (incl. nearest-neighbor=0) + resampling | 4 + upsampling_mode | Multiple flags + `params->already_downsampled` | 🟠 (partial) | 🟠 | Orange | Pixel-art use case (upsampling_mode=0) and full interaction not first-class. |
| 9 | `--frame_indexing` (strict regex `^(0*\|1[01]*)$` + first-frame rule) | 31 (via `JXL_ENC_FRAME_INDEX_BOX`) | Dedicated validation block in `ProcessFlags` | ❌ | ❌ | Orange | Non-trivial per-frame indexing contract. No equivalent surface. |
| 10 | `--allow_expert_options` (explicit gate for effort=11) | — (effort 11) | Guarded path before `ProcessFlag` for effort | 🟠 (type caps at 9) | 🟠 | Orange | Reference treats this as intentionally dangerous. We should mirror the gate. |
| 11 | `--disable_perceptual_optimizations` | 39 | Direct `params->AddOption` | ❌ | ❌ | Orange | Critical for reproducible benchmarking and certain archival workflows. |
| 12 | Full `dec-hints` (color_space, icc_pathname, strip=*) | — | `AddCommandLineOptions` + `Foreach` stripping | 🟠 | 🟠 | Orange | Rich override/strip behavior for JPEG recompression paths. |
| 13 | `--progressive` as convenience bundle | multiple (13 + 16 + 17 + 18) | `ProcessFlags` ~530 | 🟠 (partial `progressiveFlavor`) | 🟠 | Orange | The "set good progressive defaults with one flag" UX is missing. |
| 14 | `--photon_noise_iso` (recommended path) | 5 | Dedicated parser + `ProcessFlag` | ✅ | ✅ | ✅ | Rare alignment with current cjxl recommendation. |
| 15 | `--keep_invisible` | 12 | `ProcessBoolFlag` | ❌ | ❌ | Orange | Explicit invisible-pixel preservation control. |
| 16 | Full modular_* suite with ranges (`--modular_colorspace -1..41`, predictor `0..15`, `nb_prev_channels`, etc.) | 25, 26, 27, 28, 29, ... | Help level 4 + many `ProcessFlag` calls with validators | 🟠 (partial `ModularOptions`) | 🟠 | Orange | `ModularOptions` covers a useful subset but misses RCT index, full predictor range, etc. |
| 17 | `--jpeg_reconstruction_cfl` + `--compress_boxes` (JPEG paths) | 30, 33 | Conditional `ProcessBoolFlag` when `jpeg_bytes` | 🟠 | 🟠 | Orange | Granular control over CFL and Brotli box compression for JPEG recompression. |
| 18 | Separate `--resampling` and `--ec_resampling` | 2, 3 | Two distinct flags + validators | 🟠 (single `resampling` field) | 🟠 | Orange | Extra-channel resampling is not independently controllable today. |
| 19 | `--premultiply` (force associated alpha) | — | `ParseSigned` → `params->premultiply` | ❌ | ❌ | Orange | Explicit control over premultiplied vs straight alpha. |
| 20 | `--intensity_target` (nits) | — | `ParseIntensityTarget` → `params->intensity_target` | ❌ | ❌ | Orange | HDR signaling knob with no first-class exposure. |
| 21 | `--codestream_level` (-1\|5\|10) | — | Direct assignment | ❌ | ❌ | Orange | Level 10 features are gated in the reference. We should surface this. |
| 22 | `--streaming_input` / `--streaming_output` + explicit buffering interaction | 34 (via buffering=3) | Dedicated flags + `JxlOutputProcessor` path | 🟠 (chunked is related but opaque) | 🟠 | Orange | First-class streaming modes with documented tradeoffs. Our current model hides this. |
| 23 | Top-level `--container` + `--compress_boxes` decisions | 33 (partial) | Early flags + container logic in `main` | 🟠 (some `MetadataOptions`) | 🟠 | Orange | Container and box compression policy is coarser in our surface. |

### New Gaps Summary (cjxl_main.cc) — Categorized

**Ergonomics & Discoverability (highest user impact)**
- GROUP_ORDER + centers, DOTS, PATCHES, EPF, GABORISH, KEEP_INVISIBLE, PREMULTIPLY, INTENSITY_TARGET
- The `--progressive` convenience bundle

**Validation & Safety**
- All range checks and mutual-exclusion rules that cjxl enforces before the C API (center requires group_order, effort 11 gate, frame_indexing regex + first-frame rule, etc.)
- `allow_expert_options` pattern

**Progressive / Streaming / Memory**
- Full `BUFFERING` modes with documented tradeoffs
- `--streaming_input` / `--streaming_output`
- `--frame_indexing`

**JPEG Recompression**
- Fine-grained strip controls + reconstruction warnings
- `--jpeg_reconstruction_cfl`, `--compress_boxes` (JPEG-specific)

**Modular**
- Complete modular_* suite (colorspace/RCT, predictor full range, nb_prev_channels, etc.) beyond current `ModularOptions`

**Resampling & Downsampling**
- Independent extra-channel resampling
- `already_downsampled` + `upsampling_mode` (incl. nearest-neighbor for pixel art)

**HDR / Level / Alpha**
- `intensity_target`, `codestream_level`, `premultiply`

**Recommendation for next step:**
Create (or extend) a design note **"First-class Advanced Encoder Controls"** that proposes:
- A coherent `AdvancedEncoderOptions` / `EncoderFeatures` surface (or extension of `ModularOptions`).
- Typed enums or branded numbers where ranges are small.
- Mirroring of cjxl validation where cheap.
- Clear documentation of which controls are "expert" vs normal.
- Decision on whether `advancedFrameSettings` remains as an ultimate escape hatch (it probably should).

Prioritize the top ~10 items above for the first slice (GROUP_ORDER family, DOTS/PATCHES/EPF/GABORISH, BUFFERING, progressive bundle, and the expert gate).

---

## 2. Official libjxl encode.h (JxlEncoderFrameSettingId enum)

**Reproducibility**
- Commit / Revision: `714ce6b64cd859675e470d519a338a132fe7b1c1`
- Fetched via: raw.githubusercontent.com (web_fetch at exact commit)
- Date fetched: 2026-06-13
- Date audited: 2026-06-13

**Seeded rows status:** All pre-existing example rows were re-verified against the pinned source above. Yes — GROUP_ORDER (13), DOTS (7), EPF (9), and BUFFERING (34) status confirmed as only escape/internal or missing first-class support (consistent with cjxl_main.cc audit).

**Notes on process:**
- Extracted the complete `JxlEncoderFrameSettingId` enum + all surrounding comments from `lib/include/jxl/encode.h` at the pinned commit.
- Cross-referenced every value against current first-class surface in:
  - `packages/jxl-wasm/src/facade.ts` (`EncoderOptions`, `ModularOptions`, `advancedFrameSettings`)
  - `packages/jxl-wasm/src/bridge.cpp` (all `JxlEncoderFrameSettingsSetOption` calls)
- Ruthless standard applied: only named, typed, documented, validated fields in `EncoderOptions`/`ModularOptions` count as first-class. Everything else (including `advancedFrameSettings`) is Orange at best.
- This audit is deliberately against the *same baseline* as the cjxl_main.cc audit.

### Complete Enum Audit

| Enum Value | ID | Description (from header) | WASM | Native | Severity | Notes |
|------------|----|---------------------------|------|--------|----------|-------|
| `JXL_ENC_FRAME_SETTING_EFFORT` | 0 | Encoder effort/speed level (1-10, 11 with expert gate) | ✅ | ✅ | ✅ | Well supported (1-9 first-class; 11 gated in reference) |
| `JXL_ENC_FRAME_SETTING_DECODING_SPEED` | 1 | Decoding speed tier hint (0-4) | ✅ | ✅ | ✅ | First-class (`decodingSpeed`) |
| `JXL_ENC_FRAME_SETTING_RESAMPLING` | 2 | Downsampling before compression (1/2/4/8) | 🟠 | 🟠 | Orange | Partial — no independent extra-channel control |
| `JXL_ENC_FRAME_SETTING_EXTRA_CHANNEL_RESAMPLING` | 3 | Resampling for extra channels | ❌ | ❌ | Orange | No first-class exposure (only via escape) |
| `JXL_ENC_FRAME_SETTING_ALREADY_DOWNSAMPLED` | 4 | Input is already downsampled | 🟠 | 🟠 | Orange | Partial wiring exists; not first-class + no upsampling_mode |
| `JXL_ENC_FRAME_SETTING_PHOTON_NOISE` | 5 | Synthetic film/sensor noise (ISO) | ✅ | ✅ | ✅ | First-class (`photonNoiseIso`) — aligned with cjxl recommendation |
| `JXL_ENC_FRAME_SETTING_NOISE` | 6 | Deprecated adaptive noise (use photon_noise instead) | ❌ | ❌ | N/A | Correctly not exposed (cjxl treats as deprecated) |
| `JXL_ENC_FRAME_SETTING_DOTS` | 7 | Dots generation enable/disable | 🟠 | 🟠 | Orange | Only via advancedFrameSettings |
| `JXL_ENC_FRAME_SETTING_PATCHES` | 8 | Patches generation enable/disable | 🟠 | 🟠 | Orange | Only via advancedFrameSettings (our docs even cite it as example use) |
| `JXL_ENC_FRAME_SETTING_EPF` | 9 | Edge-preserving filter strength (-1..3) | ❌ | ❌ | Orange | Strong production control with validation — completely missing |
| `JXL_ENC_FRAME_SETTING_GABORISH` | 10 | Gaborish filter enable/disable | ❌ | ❌ | Orange | Only via escape hatch |
| `JXL_ENC_FRAME_SETTING_MODULAR` | 11 | Force modular (1) vs VarDCT (0) | ✅ | ✅ | ✅ | First-class (`modular` field) |
| `JXL_ENC_FRAME_SETTING_KEEP_INVISIBLE` | 12 | Preserve color of invisible pixels | ❌ | ❌ | Orange | No first-class exposure |
| `JXL_ENC_FRAME_SETTING_GROUP_ORDER` | 13 | Group storage order (scanline vs center-first) | 🟠 | 🟠 | Orange | Only via advancedFrameSettings |
| `JXL_ENC_FRAME_SETTING_GROUP_ORDER_CENTER_X` | 14 | Center X for center-first ordering | 🟠 | 🟠 | Orange | Only via advancedFrameSettings + no validation |
| `JXL_ENC_FRAME_SETTING_GROUP_ORDER_CENTER_Y` | 15 | Center Y for center-first ordering | 🟠 | 🟠 | Orange | Only via advancedFrameSettings + no validation |
| `JXL_ENC_FRAME_SETTING_RESPONSIVE` | 16 | Modular progressive (squeeze) | 🟠 | 🟠 | Orange | Partially tied to `progressive` but not independently controllable |
| `JXL_ENC_FRAME_SETTING_PROGRESSIVE_AC` | 17 | Progressive AC (spectral) | 🟠 | 🟠 | Orange | Only through `progressive` + `progressiveFlavor` bundle |
| `JXL_ENC_FRAME_SETTING_QPROGRESSIVE_AC` | 18 | Progressive AC with shift quantization | 🟠 | 🟠 | Orange | Only through the progressive bundle |
| `JXL_ENC_FRAME_SETTING_PROGRESSIVE_DC` | 19 | Progressive DC levels (0-2) | 🟠 | 🟠 | Orange | Only through the progressive bundle |
| `JXL_ENC_FRAME_SETTING_CHANNEL_COLORS_GLOBAL_PERCENT` | 20 | Global channel palette % | 🟠 | 🟠 | Orange | Partially covered in `ModularOptions` but not first-class |
| `JXL_ENC_FRAME_SETTING_CHANNEL_COLORS_GROUP_PERCENT` | 21 | Per-group channel palette % | 🟠 | 🟠 | Orange | Same as above |
| `JXL_ENC_FRAME_SETTING_PALETTE_COLORS` | 22 | Max colors for palette | 🟠 | 🟠 | Orange | Exposed in `ModularOptions` but limited |
| `JXL_ENC_FRAME_SETTING_LOSSY_PALETTE` | 23 | Delta palette in lossy mode | 🟠 | 🟠 | Orange | Exposed in `ModularOptions` but no validation against progressive |
| `JXL_ENC_FRAME_SETTING_COLOR_TRANSFORM` | 24 | Internal color transform (XYB / none / YCbCr) | ❌ | ❌ | Orange | No exposure |
| `JXL_ENC_FRAME_SETTING_MODULAR_COLOR_SPACE` | 25 | Reversible color transform (RCT) index (-1..41) | ❌ | ❌ | Orange | Missing — one of the more important modular controls |
| `JXL_ENC_FRAME_SETTING_MODULAR_GROUP_SIZE` | 26 | Modular group size (-1..3) | 🟠 | 🟠 | Orange | Covered in `ModularOptions.groupSize` |
| `JXL_ENC_FRAME_SETTING_MODULAR_PREDICTOR` | 27 | Modular predictor (0-15) | 🟠 | 🟠 | Orange | Covered in `ModularOptions.predictor` |
| `JXL_ENC_FRAME_SETTING_MODULAR_MA_TREE_LEARNING_PERCENT` | 28 | MA tree learning % | 🟠 | 🟠 | Orange | Covered in `ModularOptions.maTreeLearningPercent` |
| `JXL_ENC_FRAME_SETTING_MODULAR_NB_PREV_CHANNELS` | 29 | Previous channel properties for MA trees | 🟠 | 🟠 | Orange | Covered in `ModularOptions.nbPrevChannels` |
| `JXL_ENC_FRAME_SETTING_JPEG_RECON_CFL` | 30 | Chroma-from-luma for JPEG reconstruction | 🟠 | 🟠 | Orange | No first-class control |
| `JXL_ENC_FRAME_INDEX_BOX` | 31 | Mark frame for frame index box | ❌ | ❌ | Orange | Only via raw escape (complex contract) |
| `JXL_ENC_FRAME_SETTING_BROTLI_EFFORT` | 32 | Brotli effort for metadata/boxes | ✅ | ✅ | ✅ | First-class (`brotliEffort`) |
| `JXL_ENC_FRAME_SETTING_JPEG_COMPRESS_BOXES` | 33 | Brotli-compress JPEG-derived boxes | 🟠 | 🟠 | Orange | Coarse control only via `MetadataOptions` |
| `JXL_ENC_FRAME_SETTING_BUFFERING` | 34 | Buffering strategy for chunked encoding (-1..3) | 🟠 | 🟠 | Orange | Used internally for `chunked`; no user-facing API |
| `JXL_ENC_FRAME_SETTING_JPEG_KEEP_EXIF` | 35 | Keep EXIF in JPEG recompression | 🟠 | 🟠 | Orange | Coarse via `MetadataOptions.includeExif` |
| `JXL_ENC_FRAME_SETTING_JPEG_KEEP_XMP` | 36 | Keep XMP in JPEG recompression | 🟠 | 🟠 | Orange | Coarse via `MetadataOptions.includeXMP` |
| `JXL_ENC_FRAME_SETTING_JPEG_KEEP_JUMBF` | 37 | Keep JUMBF in JPEG recompression | 🟠 | 🟠 | Orange | Very limited exposure |
| `JXL_ENC_FRAME_SETTING_USE_FULL_IMAGE_HEURISTICS` | 38 | Use full-image heuristics (for streaming equivalence) | ❌ | ❌ | Orange | Not exposed (mostly internal/testing) |
| `JXL_ENC_FRAME_SETTING_DISABLE_PERCEPTUAL_HEURISTICS` | 39 | Disable perceptual optimizations | ❌ | ❌ | Orange | Important for benchmarking — completely missing |
| `JXL_ENC_FRAME_SETTING_FILL_ENUM` | 65535 | Sentinel (not a real setting) | N/A | N/A | N/A | — |

### New Gaps Summary (encode.h enum)

**Completely unexposed (Red territory if they matter in practice):**
- EXTRA_CHANNEL_RESAMPLING (3)
- EPF (9)
- GABORISH (10)
- KEEP_INVISIBLE (12)
- COLOR_TRANSFORM (24)
- MODULAR_COLOR_SPACE (25) — high value
- FRAME_INDEX_BOX (31)
- DISABLE_PERCEPTUAL_HEURISTICS (39) — high value for benchmarking
- USE_FULL_IMAGE_HEURISTICS (38)

**Only via escape hatch (Orange):**
- DOTS, PATCHES, GROUP_ORDER family, RESAMPLING variants, most JPEG metadata controls, BUFFERING, many modular fine controls.

**Well covered (✅):**
- EFFORT, DECODING_SPEED, PHOTON_NOISE, MODULAR (basic), BROTLI_EFFORT

**Notable pattern gaps vs the enum + cjxl usage:**
- No independent extra-channel resampling
- No `upsampling_mode` equivalent
- No explicit expert gating for effort=11
- Progressive controls are bundled rather than independently addressable
- Many settings that have dedicated comments and numeric IDs in the header have zero discoverable surface in our API

This enum audit + the cjxl_main.cc audit together give a near-complete picture of the production encoder option surface that the reference actually uses.

---

## 3. jpegxl-rs

**Reproducibility**
- Commit / Revision: `0d3590d5c8d3bd57128f70b89fc190f48de60cdd` (master as of 2026-04)
- Fetched via: raw.githubusercontent.com at above commit (via GitHub API for tree discovery)
- Date fetched: 2026-06-13
- Date audited: 2026-06-13

**Seeded rows status:** N/A — this section focuses on API shape and ergonomics rather than individual frame settings.

**Notes on process:**
- Focused on the public builder API in `jpegxl-rs/src/encode.rs` and `options.rs` at the pinned commit.
- Paid special attention to how they surface high-level options vs. the explicit `set_frame_option` escape hatch.
- Compared against our `EncoderOptions` + `advancedFrameSettings` + `ModularOptions` surface.
- Also reviewed error handling and builder ergonomics.

### Key Ergonomic / API Differences

**High-level builder is significantly nicer than raw C / our current TS surface**
- Uses the `bon` builder crate for a very fluent `encoder_builder().speed(...).quality(...).build()?` style.
- Has a proper `EncoderSpeed` enum with named variants (`Lightning`, `Squirrel`, `Glacier`, etc.) instead of raw numbers. This is much more discoverable than our `effort: 1 | 2 | ... | 9`.
- `jpeg_quality(quality: f32)` helper that internally calls `JxlEncoderDistanceFromQuality` — a convenience we don't expose.
- Clear, documented fields for `lossless`, `decoding_speed`, `use_container`, `uses_original_profile`, `target_intensity`, etc.

**Escape hatch is explicit and well-documented**
- They have a public method: `pub fn set_frame_option(&mut self, option: JxlEncoderFrameSettingId, value: i64) -> Result<(), EncodeError>`
- It is presented as the intentional way to reach anything not covered by the high-level builder.
- This is the direct inspiration for our `advancedFrameSettings` array (our comments even reference `jpegxl-rs set_frame_option`).

**Error handling is first-class**
- Proper `EncodeError` enum with variants for `OutOfMemory`, `Jbrd`, `BadInput`, `NotSupported`, `ApiUsage`, etc.
- All fallible operations return `Result<..., EncodeError>`.
- In contrast, our current surface leans heavily on throwing or silent failure paths in many places.

**Modular controls**
- Still largely rely on `set_frame_option` for fine-grained modular settings (predictor, group size, palette, MA tree %, etc.).
- They do not appear to have a dedicated `ModularOptions`-style struct in this snapshot (our `ModularOptions` is actually ahead in some ways for the modular subset).

**Other notable differences**
- They expose `parallel_runner` as a first-class concept on the encoder.
- `init_buffer_size` tuning is directly available.
- Color encoding handling is more explicit (`ColorEncoding` enum + `target_intensity`).
- The crate is designed for both one-shot and multi-frame (`multiple(...)` method that returns a `MultiFrames` guard).

**What this means for our surface**
- Our `advancedFrameSettings` is conceptually aligned with their escape hatch, which is good.
- However, we are missing many of the high-level ergonomic wins they provide on top of the raw settings (named speed enum, jpeg_quality helper, better error types, clearer builder).
- For the settings that *are* first-class in both, their API is generally more pleasant and safer.

### New Gaps / Opportunities Summary (jpegxl-rs)

- **Ergonomics debt**: Even for options we *do* support first-class, the presentation is weaker (raw numbers for effort/speed instead of enums, no `jpeg_quality` helper, no strong builder pattern).
- **Error handling**: Their `EncodeError` is more granular and Rust-idiomatic than what we currently surface to TS/JS consumers.
- **Escape hatch philosophy**: They treat `set_frame_option` as a documented, supported part of the public API rather than a "power user / internal" escape. This is a healthier model than our current "advancedFrameSettings" framing.
- **Modular parity**: Our `ModularOptions` is actually reasonably competitive (and in some cases ahead) of what jpegxl-rs exposes at this commit for the modular subset.

**Recommendation**: When designing the "First-class Advanced Encoder Controls" surface, strongly consider adopting patterns from this crate (especially named enums for effort/speed, a clear documented escape hatch method, and better error types) rather than inventing purely from the C API or cjxl CLI.

---

## 4. chafey/libjxl-js

**Reproducibility**
- Commit / Revision: `dd0538527e708fdb12cda4a633ff81656d35ee77` (last meaningful commit on main, 2022-03)
- Fetched via: raw.githubusercontent.com at above commit
- Date fetched: 2026-06-13
- Date audited: 2026-06-13

**Notes on process:**
- Focused on the thin Emscripten bindings as described in the handoff.
- Key files examined: `JpegXLEncoder.hpp`, `JpegXLDecoder.hpp`, `jslib.cpp`.
- Looked specifically for hard-coded options, progressive handling, extra channel support, and how advanced frame settings were (or were not) exposed.

### Notable Patterns

**Extremely thin / classic Emscripten binding style**
- Very small public surface exported to JavaScript.
- `JpegXLEncoder` only exposes: `getDecodedBuffer`, `getEncodedBuffer`, `setEffort`, `setQuality`, `encode`.
- `setProgressive` exists in the C++ header but is **not bound** in `jslib.cpp` EMSCRIPTEN_BINDINGS — it is unreachable from JS.

**Hard-coded production defaults in the encoder**
- Constructor defaults: `effort_(4)`, `progressive_(true)`, `lossless_(true)`.
- In `encode()` it unconditionally sets several advanced frame settings:
  - `JXL_ENC_FRAME_SETTING_EFFORT`
  - `JXL_ENC_FRAME_SETTING_RESPONSIVE` + `QPROGRESSIVE_AC` when progressive
  - `JXL_ENC_FRAME_SETTING_MODULAR_MA_TREE_LEARNING_PERCENT = 0`
  - `JXL_ENC_FRAME_SETTING_MODULAR_GROUP_SIZE = 0`

**No real first-class advanced controls**
- Users can only influence effort and lossy distance (via `setQuality`).
- Everything else (progressive flavor details, modular controls, etc.) is either hard-coded or completely inaccessible.
- This is the opposite philosophy from both cjxl and jpegxl-rs.

**Decoder is similarly minimal**
- Pure decode-to-pixels path.
- No progressive decode control, no region decoding, very little metadata exposure beyond basic FrameInfo.

**Comparison to our implementation**
- This binding is much closer to a "proof of concept" or early demo than a production encoder surface.
- Our current WASM path (even with `advancedFrameSettings`) is already significantly more capable and flexible than what chafey exposed.
- The main historical value is seeing what a minimal, hard-coded binding looked like in 2021–2022.

### New Gaps / Observations Summary (chafey)

- Hard-coding of advanced settings inside the binding (especially modular MA tree + group size = 0) shows what someone thought were reasonable "good defaults" for web at the time.
- The fact that `setProgressive` was never wired to JS is a good cautionary tale about API surface drift.
- This reinforces that a thin binding without a thoughtful high-level API or documented escape hatch quickly becomes limiting.

This library is now mostly of historical interest for the audit. It does not represent current best practice for libjxl bindings.

---

## 5. libvips (jxlsave.c / jxlload.c)

**Reproducibility**
- Commit / Revision: `78d0831539ae8902082331f8f6265733715cc842` (master as of late May 2026)
- Fetched via: raw.githubusercontent.com at above commit
- Date fetched: 2026-06-13
- Date audited: 2026-06-13

**Notes on process:**
- Focused on `libvips/foreign/jxlsave.c` and `jxlload.c` at the pinned commit (the two files explicitly called out in the handoff).
- Emphasis on production patterns: extra channel / multi-band handling, animation/multipage, progressive/interlace, color management (CICP + ICC), memory efficiency (chunked encoding), metadata, and any heuristics not present in cjxl or jpegxl-rs.

### Production Patterns Worth Adopting

**Extremely sophisticated production encoder (jxlsave.c)**
- Uses `JxlEncoderAddChunkedFrame()` + custom `JxlChunkedFrameInputSource` callbacks for low-memory encoding of large images (the 2025-era path).
- Proper tile-based input with a hash table to manage live regions (`tile_hash` + mutex).
- Full multipage + animation support with correct duration handling (including the special 0xffffffff "infinite" duration used for static multipage JXL).
- Very careful CICP color encoding round-tripping for HDR (PQ/HLG) — prefers structured CICP over ICC when the transfer function cannot be represented in ICC.
- Extensive metadata box support (Exif with the special 4-byte offset stripping, XMP, JUMBF) plus correct handling of the "Exif\0\0" prefix issue.
- Evaluation/progress callbacks wired through `vips_image_eval`.
- Graceful handling of >4 band images (currently limited, with a clear FIXME).

**Decoder (jxlload.c) is equally careful**
- Proper animation frame delay array + gif-delay fallback.
- Distinguishes "animated" vs "multipage" JXL by looking at delay values (-1 vs real durations).
- Good ICC + CICP handling on load.
- Correct EXIF prefix stripping on read.
- Supports page/n selection for animations/multipage.

**Heuristics and opinionated choices**
- Forces minimum 100ms frame duration for very short/zero frames (to match browser behavior).
- Strong preference for chunked encoding paths when available (libjxl ≥ 0.9).
- Careful bit-depth and format mapping (right-justified input, etc.).

**What this means for us**
- libvips is one of the most complete real-world users of the modern libjxl API (especially the chunked + output processor paths).
- Many of the "advanced" controls we are still missing (independent extra channel handling, proper HDR CICP, clean multipage/animation duration model, metadata box correctness) are solved problems in libvips.
- Their approach to progressive ("interlace" in the API) is also more nuanced than a simple boolean.

### New Gaps / Observations Summary (libvips)

- Extra channel / multi-band handling in production is still a weak area for us compared to libvips.
- Animation + multipage duration modeling (especially the 0xffffffff convention) is something we should adopt if we grow real animation support.
- The CICP + ICC priority logic for HDR is more sophisticated than what most bindings do.
- Chunked / low-memory paths are now the recommended production route in libvips (2025+). Our current model is still mostly buffered.

**Recommendation**: When we eventually design the high-level advanced encoder surface, the libvips jxlsave.c implementation (especially the chunked input source and color handling) should be treated as a primary reference alongside cjxl.

---

## Consolidated Master Gap List (2026-06)

### From cjxl_main.cc audit (commit `714ce6b64cd859675e470d519a338a132fe7b1c1`)

**Ergonomics & Discoverability (highest user impact)**
- GROUP_ORDER + CENTER_X/Y (with validation)
- DOTS (7), PATCHES (8), EPF (9), GABORISH (10), KEEP_INVISIBLE (12), PREMULTIPLY, INTENSITY_TARGET
- `--progressive` convenience bundle

**Validation & Safety**
- All cjxl range checks + mutual exclusion rules before C API calls
- `allow_expert_options` explicit gate for effort=11

**Progressive / Streaming / Memory**
- Full BUFFERING (34) modes with documented tradeoffs
- `--streaming_input` / `--streaming_output` (tied to buffering=3 + JxlOutputProcessor)
- `--frame_indexing` (strict regex + first-frame rule)

**JPEG Recompression**
- Fine-grained strip controls via dec-hints + reconstruction warnings
- `--jpeg_reconstruction_cfl` (30), `--compress_boxes` (JPEG-specific, 33)

**Modular**
- Complete modular_* suite (colorspace/RCT 25, predictor 27 full 0..15 range, nb_prev_channels 29, etc.) beyond current `ModularOptions`

**Resampling & Downsampling**
- Independent extra-channel resampling (3)
- `already_downsampled` (4) + `upsampling_mode` (incl. nearest-neighbor=0 for pixel art)

**HDR / Level / Alpha / Container**
- `intensity_target`, `codestream_level`, `premultiply`, top-level container + compress_boxes policy

**Cross-cutting Pattern Debt**
- Almost everything above is only reachable via untyped `advancedFrameSettings` escape hatch.
- No equivalent to cjxl’s pre-validation, helpful error messages, or guarded expert paths.
- Missing convenience bundles that the reference treats as important UX.

**From the full enum audit (same baseline):**
- Several high-value settings have **zero** first-class exposure despite having dedicated IDs and documentation in the official header: EPF (9), DISABLE_PERCEPTUAL_HEURISTICS (39), MODULAR_COLOR_SPACE (25), EXTRA_CHANNEL_RESAMPLING (3), FRAME_INDEX_BOX (31), etc.
- The gap is not just "missing a few options" — it is that the entire production encoder configuration surface used by cjxl and documented in encode.h is almost entirely hidden behind an escape hatch.

**From chafey/libjxl-js (historical thin binding):**
- Classic example of hard-coded advanced settings inside the binding (MODULAR_MA_TREE = 0, GROUP_SIZE = 0, specific progressive flags) with almost no user control.
- `setProgressive` existed in C++ but was never wired to JS — a cautionary tale about API surface rot.
- Reinforces that a thin binding without a documented escape hatch or thoughtful high-level API quickly becomes limiting. (Mostly of historical value now.)

**From libvips (jxlsave.c / jxlload.c — current production gold standard):**
- Chunked encoding (`JxlEncoderAddChunkedFrame` + custom input source) is now the recommended low-memory path for large images.
- Sophisticated CICP + ICC priority logic for HDR (PQ/HLG) that most bindings ignore.
- Proper multipage vs. animated distinction (using 0xffffffff duration convention).
- Careful Exif prefix stripping and metadata box handling.
- Extra-channel and multi-band production patterns that are still weak in our surface.
- Evaluation/progress callbacks and tile management for chunked paths.

**Recommended next artifact:** A design note titled “First-class Advanced Encoder Controls” (2026-06) that proposes a typed surface, validation strategy, and prioritization of the top 10–12 items above. The cjxl_main.cc, encode.h, jpegxl-rs, and libvips sections of this audit should be treated as primary source material.

---

**Instructions for the person filling this:**
- Work in a clean terminal / fresh context if possible.
- Always pin the exact commit (git ls-remote + raw URL, or equivalent) and record it in the **Reproducibility** header.
- Re-verify every seeded row against the actual pinned source.
- Be ruthless with Orange and Red. "We can do it via the escape hatch" does **not** count as first-class support.
- After each major library, add a categorized "New Gaps Summary" and feed the highest-impact items into the Consolidated Master Gap List.

---

**Audit Status (2026-06)**

The five libraries originally prioritized in the handoff have been audited against pinned upstream sources:

- cjxl_main.cc (highest priority, real-world usage)
- Official libjxl encode.h enum (complete authoritative list)
- jpegxl-rs (ergonomics + escape hatch patterns)
- chafey/libjxl-js (historical thin binding reference)
- libvips jxlsave.c / jxlload.c (current production reference)

This document is now the canonical source for the next design phase ("First-class Advanced Encoder Controls").

**Targeted Gap Scan Addendum (2026-06-13)**

A focused re-examination was performed on the two highest-value sources (cjxl_main.cc + encode.h) looking specifically for high-impact under-documented patterns.

**Findings:**
- No new major Red/Orange gaps were identified that would materially change the Master Gap List.
- Minor nuances worth noting:
  - `JxlOutputProcessor` + `--streaming_output` is treated as a first-class modern low-memory path in cjxl (stronger emphasis than currently reflected).
  - Explicit forcing of `BUFFERING=3` when using `--streaming_input`.
  - `JxlEncoderStoreJPEGMetadata` is a distinct step from general box handling during JPEG reconstruction.
- These are refinements to existing rows rather than new high-priority items.

The current audit coverage on the critical sources is considered solid for design purposes.

Future work should treat the **Consolidated Master Gap List** as the prioritized backlog.
