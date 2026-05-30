# JPEG XL Wrapper Reference Index

## How to Use the References (Important - Read This First)

This index is your primary tool for efficient, high-quality feature implementation.

### Step-by-step process for any new feature:

1. **Identify the feature** you want to implement (from the main Gaps document or Sprint list).

2. **Look it up** in the Feature Index below.

3. **Collect the reference code**:
   - Note the recommended files for each library.
   - Use the line guidance (approximate) to jump to the relevant implementation.
   - Ask the system to read or quote the specific sections from the files in the eferences/ folder (or fetch the originals from GitHub if needed).

4. **Compare approaches** across the libraries:
   - How does the thin low-level binding do it? (chafey)
   - How does a nice high-level API look? (jpegxl-rs)
   - How does a production high-level wrapper choose to abstract it? (libvips + cjxl_main.cc)
   - What does the raw reference implementation expect? (official examples + headers)

5. **Design** the feature for both WASM and Tauri, using the best ideas from the references while respecting platform constraints. Check current parity status first in `docs/FEATURE_PARITY_MATRIX.md` (the single authoritative WASM / Tauri / Benchmark exposure table).

6. **Implement** following the FEATURE_IMPLEMENTATION_TEMPLATE.md (branching, benchmark wiring, cleanup, etc.).

7. **Record progress** by appending an entry to PROGRESS_LOG.md at the end of the work.

8. **Update this index** with your new implementation locations and any new insights. Also update `DESIGNS_INDEX.md` status and the master `FEATURE_PARITY_MATRIX.md`.

### Tips
- cjxl_main.cc is usually the best place to see real production usage of many options together.
- jpegxl-rs is the best model for clean high-level Rust API design (recommended for Tauri).
- Always cross-reference with the raw libjxl headers for the exact constants and behavior.
- The goal is not to copy code, but to understand the patterns and make good design decisions for our custom implementations.

---
**Purpose**  
This index maps high-value JXL features across several open-source implementations. It is designed so that when implementing a feature in **CasaWASM** (WASM/JS + bridge) and **Tauri** (native), the agent can rapidly pull the most relevant code sections from each reference, compare approaches, and design clean custom implementations.

**Current References** (local copies / notes in this folder)
- chafey/libjxl-js (Embind C++ → JS)
- inflation/jpegxl-rs (high-level Rust)
- libvips (production C)
- Official libjxl (encode_oneshot.cc + headers)
- **cjxl_main.cc** (official full-featured CLI encoder — best real-world usage of *all* options)
- **jpegxl-rs** (expanded) — high-level safe Rust wrapper (excellent design reference)

---

## How to Use

1. Look up the feature.
2. Note the files + line guidance.
3. Have the agent read the specific sections.
4. Compare the approaches.
5. Design CasaWASM + Tauri versions.

---

## Feature Index (Updated with New References)

### 1. Basic Encoding (Effort, Quality/Distance, Lossless)

**chafey/libjxl-js**
- `JpegXLEncoder.hpp`: setEffort, setQuality, encode()

**inflation/jpegxl-rs**
- `encode.rs`: JxlEncoder struct + builder (speed/quality/lossless)

**libvips**
- `jxlsave.c`: effort / distance / Q / lossless handling

**Official libjxl**
- `encode_oneshot.cc`: EncodeJxlOneshot() — raw usage of effort, distance, lossless

**cjxl_main.cc** (new)
- `ProcessFlags()` + `AddCommandLineOptions()`: Full mapping of --effort, --distance, --quality, --lossless_jpeg, etc. (very comprehensive real-world usage, especially around lines handling CompressArgs and SetDistanceFromFlags)

**libjxl Reference**
- `encode.h`: JXL_ENC_FRAME_SETTING_EFFORT, JxlEncoderSetFrameDistance, JxlEncoderSetFrameLossless

---

### 2. Progressive / Interlace Encoding

**chafey/libjxl-js**
- `JpegXLEncoder.hpp`: setProgressive + sets RESPONSIVE + QPROGRESSIVE_AC

**inflation/jpegxl-rs**
- Escape hatch via set_frame_option for progressive constants

**libvips**
- `jxlsave.c`: `interlace` flag mapped to progressive settings (good high-level example)

**Official libjxl**
- See frame settings in encode_oneshot.cc (extendable)

**cjxl_main.cc** (new)
- Handles --progressive, --progressive_ac, --qprogressive_ac, --progressive_dc, --responsive in ProcessFlags() and option registration (excellent reference for how the full set of progressive options is wired together)

**libjxl Reference**
- PROGRESSIVE_DC, PROGRESSIVE_AC, QPROGRESSIVE_AC, RESPONSIVE, GROUP_ORDER, etc.

---

### 3. Modular Mode & Advanced Modular Controls

**chafey/libjxl-js**
- Hard-coded some modular settings in encode()

**inflation/jpegxl-rs**
- Full escape hatch via set_frame_option for the entire Modular family

**libvips**
- Mostly implicit

**Official libjxl**
- Raw constants

**cjxl_main.cc** (new)
- Very detailed handling of --modular, --modular_colorspace, --modular_group_size, --modular_predictor, --modular_nb_prev_channels, --modular_palette_colors, --modular_lossy_palette, --modular_ma_tree_learning_percent, channel colors percent, etc. (one of the best places to see real usage of the full Modular option set)

**libjxl Reference**
- Full JXL_ENC_FRAME_SETTING_MODULAR_* family

---

### 4. Extra Channels

**chafey/libjxl-js**
- Basic via componentCount

**inflation/jpegxl-rs**
- Via PixelFormat + metadata

**libvips**
- Strong multi-band → extra channel mapping (production reference)

**cjxl_main.cc** (new)
- Handles alpha_distance and extra channel options via the CLI (good for seeing how per-channel distance is exposed)

**libjxl Reference**
- Full ExtraChannel API

**CasaWASM Implementation (Phase 2 complete):**
- Rich types + 72B descriptor: `packages/jxl-wasm/src/facade.ts:147-184` (ExtraChannelType + SpotColorInfo + ExtraChannel + DecodedExtraChannel), `147-154` (full enum incl. reserved0-7 + unknown), `packages/jxl-wasm/src/bridge.cpp:92-102` (WasmExtraChannel struct, exact 72B layout), `packages/jxl-native/src/index.ts:41-75` (mirrored types for parity), `packages/jxl-native/src/native.cc:51-63` (ExtraChannelDesc)
- Encode paths: `packages/jxl-wasm/src/facade.ts:490-513` (serializeExtraChannelsForWasm + EC_BYTES=476), `bridge.cpp:546-639` (EncodeRgbaWithExtraChannels + per-EC SetExtraChannelInfo/Name/Distance/Buffer), `native.cc:620-672` (extra channel setup loop + Set* + buffer)
- Decode / descriptor paths: `facade.ts:529-` (deserializeExtraChannelsFromWasm), `1165-1182` (header info attachment), `1219-1300` (extraPlanes on events), `bridge.cpp:269-304` (decode desc collection to 72B sidecar), `2127-2191` (jxl_wasm_get_extra_channels helper), `native.cc:495-527` (decoder extra_channels collection + MakeExtraChannelObject)
- Tests: `packages/jxl-wasm/test/facade.test.ts:886-` (Phase 2 describe + Task 7 matrix: all types, bits, unicode/long names, spot, mixed, dimShift, many-EC, decoder header/final reports)
- Also: `packages/jxl-wasm/src/facade.ts:1166-1444` (progressive decoder extra handling)

---

### 5. Photon Noise

**cjxl_main.cc** (new)
- --photon_noise_iso option fully wired (best real-world example of how this advanced feature is used)

**libjxl Reference**
- JXL_ENC_FRAME_SETTING_PHOTON_NOISE

---

### 6. Decoding Speed Tier

**inflation/jpegxl-rs**
- decoding_speed field

**libvips**
- tier option

**cjxl_main.cc** (new)
- --faster_decoding flag mapped to DECODING_SPEED

---

### 7. Brotli Effort

**cjxl_main.cc** (new)
- --brotli_effort option (range 0-11, default 9) — one of the few places this is exposed at a high level

**libjxl Reference**
- JXL_ENC_FRAME_SETTING_BROTLI_EFFORT

---

### 8. Animation / Multi-Frame

**libvips**
- Excellent (delay arrays, loop, blending)

**inflation/jpegxl-rs**
- multiple() API

**cjxl_main.cc**
- Handles multipage/animation input and frame settings

---

### 9. Metadata Boxes + Brotli Compression

**inflation/jpegxl-rs**
- add_metadata with compress flag

**cjxl_main.cc**
- Extensive handling of --compress_boxes, metadata stripping, JPEG reconstruction, etc.

---

## Summary of New References Added

- **cjxl_main.cc**: The single best real-world reference for how *all* the advanced encoder options are actually used together in a production CLI tool. Extremely valuable for option mapping, validation, and combinations.

- **jpegxl-rs (expanded)**: Best high-level ergonomic Rust API design with escape hatches. Recommended model for the Tauri side.

These two, together with the previous references, should give very strong coverage for implementing almost any missing feature.

---

**Next step recommendation**: When starting the first feature from the sprint list, follow the `FEATURE_IMPLEMENTATION_TEMPLATE.md` using this updated index.

**Important 2026-06 update**: Prior work was largely based on the thin notes in this folder. A deeper audit against the *actual* full reference sources is now underway. See:
- `DEEP_REFERENCE_CODE_AUDIT_HANDOFF.md` (method + handoff)
- `REFERENCE_CODE_AUDIT.md` (the living document where Red/Orange gaps vs real cjxl_main.cc, encode.h, jpegxl-rs, etc. are recorded)

Use the new audit files when deciding what still needs first-class exposure vs what can stay behind the escape hatch.

---

## Additional Features Identified (Audit 2026-05-28)

### 10. Gain Maps (HDR / Tone Mapping Assistance)

**Status in current index**: Not explicitly listed as a top-level section.

**Design Note**: `designs/gain-maps.md` (complete)

**References**:
- libjxl research (mentioned in earlier format_overview and changelog)
- cjxl_main.cc: Search for gain map / hdr related handling
- Recommended: Add when relevant for HDR scientific capture

### 11. Patches and Splines (Advanced Coding Tools)

**Design Note**: `designs/patches-splines.md` (complete — escape-hatch first approach)

**References**:
- Official format_overview.md (dictionary patches + Catmull-Rom splines)
- cjxl_main.cc: Look for --patches and related experimental flags
- Rarely exposed in high-level wrappers

### 12. Container vs Raw Codestream Decisions + Box Handling

**Design Note**: Covered in `designs/metadata-boxes-container.md` (complete)

**Strong reference**:
- cjxl_main.cc: Extensive logic around --container, box compression, JPEG reconstruction boxes, metadata stripping

**Recommendation**: When working on container/metadata features, cjxl_main.cc + libvips are the best guides.

---

**Note**: These were added after scanning the references (especially cjxl_main.cc) and cross-referencing with prior libjxl research. The index will continue to grow as features are implemented.

---

## Recommended Workflow (Important)

See FEATURE_IMPLEMENTATION_TEMPLATE.md (section 11) for the current recommended division of labor:

- Grok performs the research aggregation + difference analysis + produces a **Feature Design Note** in designs/.
- The agent then implements following the rest of the template, using the design note as the primary technical guide.

This hybrid approach (Grok synthesizes, agent implements with autonomy) is considered the most efficient for doing many features at high quality.
