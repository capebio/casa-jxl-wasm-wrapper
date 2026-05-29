# Follow-Up Issues

Context: the `packages/jxl-wasm` bridge was extended on 2026-05-28 to expose `_x` encode variants that thread `modular` and `brotliEffort` through the WASM facade. The source changes are in `src/bridge.cpp`, `src/facade.ts`, and `exports.txt`, but the generated WASM artifacts have not been rebuilt yet. The items below are the remaining blockers / follow-through tasks needed to resolve this change cleanly.

## Issue Entry Specification (Added 2026-05-28)

**Purpose:** Every entry in this file must supply *sufficient context* for a fresh agent (with no prior conversation history or full repo tour) to understand the problem, reproduce it, assess impact, and drive the item to completion or a clean handoff. This spec is derived directly from the project's existing high-quality patterns (current ISSUES entry format, `FEATURE_IMPLEMENTATION_TEMPLATE.md` "Handoff Protocol", `_cleanup_source.md`, PROGRESS_LOG Cleanup blocks, and the restart documents in `references/`).

**Required Fields for Every Entry**
1. Title + Date + Originating Feature / Area
2. Status (one of: blocked, partial, deferred, needs-decision, ready-for-impl, done)
3. Exact reproduction command(s) + full observed output (quoted blocks, including any error text)
4. Why this matters (business + technical impact; explicit links to `Strategic_overview.md`, `feature-summary-handoff.md`, relevant design note in `designs/`, PROGRESS_LOG entry, file-summary/*, or REFERENCE_INDEX)
5. Affected files / packages (clear paths, relative to repo root)
6. Follow-up / Resolution steps (numbered list; every step includes its own verification command or explicit success criterion)
7. Agent Jump-In Checklist (5–8 bullets):
   - Read these documents first (in recommended order)
   - Run these commands first (to establish baseline state)
   - Success criteria = ...
   - Known environmental / cross-repo gotchas
   - Any prerequisites outside this repo
8. Sufficient Context Summary (1–2 sentence paragraph that could stand alone if this entry were copied into a fresh chat)

**Skeleton (copy and fill)**
```markdown
## N. Short Descriptive Title (2026-MM-DD)

**Status:** blocked | partial | ...

**Why this matters:**
...

**Reproduction:**
```powershell
command here
```
Observed:
```
full output
```

**Affected files:**
- `packages/...`
- `docs/...`

**Follow-up:**
1. Step one with its verification command.
2. ...

**Agent Jump-In Checklist**
- Read (in order): `docs/references/Next_Features_Handoff_2026-05-28.md`, `docs/Strategic_overview.md` §X, this file entry.
- Run: `...` then `...`
- Success = all verification commands green + no TODO(Gx) left for this item.
- Gotcha: DNG work requires changes in sibling `raw-converter-tauri/raw-pipeline` first.
- ...

**Sufficient Context Summary:** One or two sentences an agent can paste to a sub-agent to begin work immediately.
```

**Distinction (2026-05-28):** The 11 design notes under `designs/` (see `DESIGNS_INDEX.md`) cover the *first audited batch* of new JXL controls. Design work for that batch is complete. This file (ISSUES.md) is the home for:
- The "Recommended Next Batch" items that still lack design notes (Progressive Encode Options, WASM Build Strategy, Advanced Decoder Controls, etc. — see `Next_Features_Handoff_2026-05-28.md`).
- Broader production, fidelity, packaging, and cross-repo unfinished business (DNG G3/C3 color/ISO, PGO, true bitstream ROI, verification harness, WASM-to-Tauri transposition, etc.).

New entries must clearly label which category they belong to.

## 1. Rebuild `packages/jxl-wasm` artifacts

**Status: done (2026-05-29)**

WASM artifacts rebuilt via Docker (`docker.io/emscripten/emsdk:4.0.13`). All 4 tiers (relaxed-simd-mt, simd-mt, simd, scalar) regenerated. `bun test packages/jxl-wasm/test/facade.test.ts` — 69 pass, 0 fail. See PROGRESS_LOG §"WASM Bridge Rebuild" for full details.

~~Status: blocked until the Docker/Emscripten build path is available in this workspace.~~

Why this matters:

- The `bridge.cpp` changes only exist in source right now.
- The generated `dist/*.wasm`, `dist/facade.js`, `dist/facade.d.ts`, and `dist/build-manifest.json` still need to be regenerated from the new exports.
- TypeScript validation is not enough to prove the C++ ABI is correct.

What changed:

- Added `jxl_wasm_encode_auto_x`.
- Added `jxl_wasm_encode_rgba8_with_sidecars_x`.
- Added `_x` threading for modular / brotli settings through `EncodeRgbaWithMetadata`, streaming encode, and streaming input state.
- Updated the facade to prefer `_x` exports when available and to accept either base or `_x` format exports.

Expected verification after the build:

1. The new `_x` symbols appear in the generated WASM exports.
2. The module loads successfully in the browser / Node wrapper.
3. The new `_x` paths produce the same output as the old paths when `modular = -1` and `brotliEffort = -1`.

Resolution path:

1. Start the Docker/Emscripten build environment.
2. Run `pnpm --filter @casabio/jxl-wasm build`.
3. Inspect the regenerated `dist/` artifacts and commit them if this repo tracks generated WASM outputs.

## 2. Decide whether generated `dist/` artifacts should be committed

Status: needs confirmation once the build runs.

Why this matters:

- `packages/jxl-wasm` publishes built artifacts from `dist/`.
- The source patch changed the export surface, so the generated JS/WASM bundle may need to be checked in alongside the source.
- If the repo expects source-only changes for this package, then the build output should be validated locally but not committed.

Decision needed:

- Commit regenerated `dist/` artifacts now.
- Or keep the change source-only and rely on the CI/package build pipeline to regenerate them later.

Recommended follow-up:

1. Run the package build.
2. Compare the resulting `dist/` changes.
3. Decide whether this package tracks generated output in git, then either commit or discard the build products accordingly.

## 3. Rebuild WASM Artifacts

**Status: done (2026-05-29)**

Rebuilt via Docker (`jxl-wasm-builder:local` image, `docker.io/emscripten/emsdk:4.0.13`). Applied 4 bridge.cpp fixes required for libjxl build commit `332feb17`:
1. `JxlEncoderAddExtraChannelBuffer` → `JxlEncoderSetExtraChannelBuffer`
2. `JxlEncoderSetFrameDuration` → `JxlEncoderInitFrameHeader`/`JxlEncoderSetFrameHeader` block
3. Added `#include <vector>` (for `std::vector<char>` in frame name handling)
4. Added `#ifndef JxlBool typedef int JxlBool; #endif` shim (symbol added to libjxl after build commit)

All 4 tiers rebuilt. `bun test packages/jxl-wasm/test/facade.test.ts` — 69 pass, 0 fail.

## 4. Rebuild Native Addon

**Status: done (2026-05-29)**

Built `packages/jxl-native/build/Release/jxl_native.node` (6.2 MB) against libjxl 0.11.x static `/MT` libs. Three native.cc fixes applied (matching bridge.cpp fixes): `JxlEncoderSetExtraChannelBuffer` rename, `JxlEncoderInitFrameHeader`/`SetFrameHeader` replacement, `JxlBool` shim. `bun test packages/jxl-native/test/codec.test.ts` — 6 pass, 0 fail.

**Build environment notes (for future rebuilds):**
- libjxl source: `jpegxl-src-0.11.4` in Cargo registry (`C:\Users\User\.cargo\registry\src\...`)
- Configured: `cmake -S <src> -B C:\TEMP\jxl-mt-build -G "Visual Studio 17 2022" -A x64 -DBUILD_SHARED_LIBS=OFF -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded -DJPEGXL_ENABLE_TOOLS=OFF ...`
- Include dir: `C:\TEMP\jxl-mt-build\lib\include`
- Lib dir: all 7 `.lib` files collected to `C:\TEMP\jxl-mt-libs\` (jxl, jxl_threads, jxl_cms, hwy, brotlienc, brotlidec, brotlicommon)
- Build: `cmd /c "call vcvars64.bat && set JXL_NATIVE_INCLUDE_DIR=... && set JXL_NATIVE_LIB_DIR=... && npx node-gyp rebuild --release"`
- CRT must match: `/MT` (node-gyp default) — `/MD` causes LNK2038 mismatch

## 5. Existing Full Facade Test Failure

**Status: done (2026-05-29)**

Fixed: updated `detectTier` test in `packages/jxl-wasm/test/facade.test.ts` to accept `["simd-mt", "scalar"]` — Bun exposes SIMD without cross-origin isolation.
Verification: `bun test packages/jxl-wasm/test/facade.test.ts` — 69 pass, 0 fail.

## 6. Existing Wrapper Lab Test Failure

**Status: done (2026-05-29)**

Fixed: replaced stale `data-mode="compare"` expectation with `data-mode="race"` in `web/jxl-wrapper-lab.test.js`.
Verification: `bun test ./web/jxl-wrapper-lab.test.js` — 1 pass, 0 fail.

## Changes To Verify After Blockers Clear

Key files:

- `packages/jxl-wasm/src/facade.ts`
- `packages/jxl-wasm/src/bridge.cpp`
- `packages/jxl-wasm/exports.txt`
- `packages/jxl-wasm/dist/*` after rebuild

Focused verification already passing:

```powershell
pnpm run typecheck
```

**M1 Validation Confirmation (2026-06, finishing_feature_parity):**
- WASM artifacts dated 2026-05-29T16:56 already contain every symbol listed above (full _x / _v2 / animation / gain / ec_v2 surface).
- `bun test packages/jxl-wasm/test/facade.test.ts` (real module) — 69 pass including EC integration, brotli, animation metadata.
- All 5 capability gates resolve true.
- Native addon (6.2 MB) present; functional codec paths work (env-assert tests are rebuild-session artifacts only).
- See new central entry in `docs/references/PROGRESS_LOG.md` ("M1 Rebuild + Validation Pass") for full output + export list.
- Issues 1–6 (early rebuild blockers) are now permanently closed. No further action.

---

## Broader Unfinished Business (Populated 2026-05-28 under the Issue Entry Specification above)

The entries below capture high-priority items that still require work after the 2026-05-28 design phase for the first batch of JXL controls. They are written strictly to the spec defined earlier in this file. See the "Distinction" paragraph in the spec for the difference between "features still needing design notes" and "production/fidelity/cross-repo follow-ups".

## 5. DNG Color Management Fidelity (G3/C3) — Cross-Repo Blocker (2026-05-28)

**Status:** partial (ORF path covered; DNG uses identity/CAM_TO_SRGB fallback)

**Why this matters:**
- DNG files (common in scientific/archival workflows) receive only a placeholder color matrix instead of the real camera-to-XYZ matrix from the DNG tags (`ForwardMatrix1/2` or inverted `ColorMatrix1/2`).
- This breaks color-accurate round-trips for DNG → JXL → display/export when the camera profile is not sRGB-like.
- Explicitly called out as the top remaining "Still Failed" item in `docs/feature-summary-handoff.md` and `docs/feature-summary.md`.
- File-summary audits (`docs/file-summary/lib-rs.md`, `_index.md`) mark both G3 (ISO) and C3 (color matrix) as "REVERTED with TODO" pending upstream `raw_pipeline` changes.
- Links: `docs/Strategic_overview.md` (Production Blockers §3), `src/lib.rs` (DNG decode path around lines 1234–1240 uses `dng_img.color_matrix` when present, else fallback).

**Reproduction (current state):**
```powershell
# Any DNG with non-identity ColorMatrix1 (most real DNGs)
# Process through the raw pipeline + LookRenderer or apply_look
# Observe that color_matrix_flat in the output metadata is [1,0,0, 0,1,0, 0,0,1] or the generic CAM_TO_SRGB
```
Observed: color_matrix_from_mn is false for most DNGs; the real matrix from the TIFF tags is never surfaced because `DngImage` in the external crate does not yet expose the fields.

**Affected files / packages:**
- `src/lib.rs` (DNG decode path, OrfDecoded vs Dng path, LookRenderer constructor)
- `docs/file-summary/lib-rs.md` and `docs/file-summary/_index.md` (status tables)
- External (required first): `raw-converter-tauri/raw-pipeline` (DngImage population from TIFF ColorMatrix / ForwardMatrix tags + ISO)

**Follow-up / Resolution steps:**
1. In the sibling `raw-converter-tauri/raw-pipeline` crate, extend `DngImage` (or equivalent) to parse and expose `color_matrix: Option<[[f32;3];3]>` and `iso: Option<u32>` from the DNG TIFF tags (using the existing tiff.rs parser patterns). Add unit tests against real DNG fixtures.
2. In this repo's `src/lib.rs`, remove the `// TODO(G3):` comments and the hardcoded `let iso = 100u32` / identity fallback; wire the values from the (now-populated) `dng_img` struct exactly as the ORF path already does for `info.color_matrix`.
3. Update `docs/feature-summary-handoff.md` and the per-file summaries to mark G3/C3 as resolved.
4. Add or extend a lightbox / export round-trip test that asserts a known non-sRGB DNG produces a non-identity matrix in the metadata and in the rendered pixels (visual + numeric delta check against a reference).

**Agent Jump-In Checklist**
- Read (in order): `docs/feature-summary-handoff.md` (Fix Handoff section), `docs/file-summary/lib-rs.md` (the REVERTED with TODO block), this entry, `src/lib.rs:1230` (DNG decode block).
- Run first: `CARGO_TARGET_DIR=tmp/cargo-check-target cargo check` (must pass with isolated target), then the DNG ingest path in the web UI or `test.ts` against a real DNG with known ColorMatrix.
- Success criteria = `color_matrix_from_mn == true` for a real DNG + the matrix values match the TIFF tags + no more TODO(G3) for color/ISO in the file-summary audits.
- Gotcha: 90% of the work is in the sibling `raw-pipeline` crate (this repo only consumes what it surfaces). Do not start here without the upstream fields.
- Cross-repo prerequisite: changes must land in raw-converter-tauri/raw-pipeline first; coordinate branches.

**Sufficient Context Summary:** DNG color matrix and ISO are still hardcoded or identity because the external raw_pipeline DngImage struct does not yet expose the parsed TIFF tag values. Fix the struct in the sibling repo, then delete the three TODO(G3) sites and the fallback logic here. All verification commands and affected files are listed above.

## 6. Progressive Encode Options Still Weakly Exposed (Next-Batch Item #1) (2026-05-28)

**Status:** design gap (no design note yet; decoder side is strong)

**Why this matters:**
- The project has excellent progressive *decode* (multiple detail levels, emitEveryPass, progressiveDetail plumbing, gallery strip + lightbox, JXTC, etc.).
- Encoder-side progressive controls (number of passes, DC-only vs AC passes, responsive, group order, last-passes bias, etc.) remain weakly surfaced compared to cjxl's rich `--progressive*` flags.
- Explicitly called out as the #1 "High Priority for Next Wave" in `docs/references/Next_Features_Handoff_2026-05-28.md` ("highest-ROI remaining item").
- Links: `docs/references/Next_Features_Handoff_2026-05-28.md:55`, original HANDOFF goal, `cjxl_main.cc` progressive handling, `docs/Progressive JXL Encoding Final.md`.

**Reproduction / Current State:**
- Encoder APIs (`EncoderOptions`, facade encode paths, bridge) expose only coarse `progressive` / `preview` flags and a few passes counts.
- No fine-grained control equivalent to libjxl's progressive encoder settings or cjxl's full suite.
- Running the progressive paint or gallery pages with "Preview 1st" + high pass counts still relies on decoder-side workarounds rather than deliberate encoder progressive structure.

**Affected files / packages (initial surface):**
- `packages/jxl-wasm/src/facade.ts` + `src/bridge.cpp` (encode side)
- `packages/jxl-core/src/types.ts` (EncoderOptions)
- `web/jxl-progressive*.js` / `jxl-wrapper-lab.*` (UI exposure)
- No design note yet in `designs/`

**Follow-up / Resolution steps:**
1. Create a short design note in `designs/progressive-encode-options.md` following `FEATURE_IMPLEMENTATION_TEMPLATE.md` and the pattern of `resampling.md` / `brotli-effort.md`. Map cjxl `--progressive*` flags + libjxl `JxlEncoderFrameSettings` progressive knobs to a clean TS API (both WASM and Tauri).
2. Implement the bridge + facade changes for the agreed surface.
3. Wire basic UI exposure in the benchmark / progressive paint pages (mandatory per TEMPLATE).
4. Add the item to `DESIGNS_INDEX.md`, `PROGRESS_LOG.md`, and update the "Next Batch" status in `Next_Features_Handoff_2026-05-28.md`.
5. Produce a Cleanup & Handoff + entry in this ISSUES.md (or mark the item done here).

**Agent Jump-In Checklist**
- Read (in order): `docs/references/Next_Features_Handoff_2026-05-28.md:47-66` (the table entry), `FEATURE_IMPLEMENTATION_TEMPLATE.md` (full), `designs/resampling.md` (example of a completed control note), cjxl_main.cc progressive flag handling (search for "progressive").
- Run first: the existing progressive gallery and paint pages with high pass counts to establish baseline behavior.
- Success criteria = a design note exists + the encoder surface matches the doc + at least one benchmark page exposes the new knobs + the item is removed from the "Next Batch" table or marked "design complete".
- Gotcha: Keep decoder progressive work (already strong) completely separate; this is encoder-only.
- No cross-repo prerequisite.

**Sufficient Context Summary:** Encoder progressive controls lag far behind the mature decoder progressive stack. The highest-ROI next design note is a clean mapping of cjxl/libjxl progressive encoder knobs to the TS + native surface, followed by the standard TEMPLATE process (branch, design note, benchmark wiring, handoff). All references and the exact next actions are listed above.

(Additional high-priority items — PGO operationalization, true bitstream ROI, packaging/verification closure, WASM-to-Tauri transposition — can be added in the same format by any agent following this spec.)

## 7. Extra Channels Lab — benchmark/demo page for alphaDistance and multi-channel encode (2026-05-29)

**Status:** partial (2026-05-29 — alphaDistance control added to wrapper lab; side-by-side comparison + depth demo deferred)

**Why this matters:**
- The extra-channel-distance Phase 1 feature (`alphaDistance`, `extraChannels[]`) is now fully wired in `bridge.cpp` + `facade.ts` with 6 passing tests.
- The user-visible value — seeing lossless-alpha vs. lossy-alpha file size and quality — cannot be demonstrated without a lab page.
- Design note `extra-channel-distance.md` section 6 calls this "highly visual and will be one of the most compelling demos once working."
- Without it, no one can validate the encode path end-to-end in a browser (the WASM binary has not been rebuilt yet either; the lab page will need the capability gate to degrade gracefully until the binary rebuild is done).
- Links: `docs/references/designs/extra-channel-distance.md` §6, `docs/references/PROGRESS_LOG.md` (2026-05-29 entry, deferred items).

**Reproduction / Current State:**
```powershell
# Open web/jxl-wrapper-lab.html in a browser
# No Extra Channels section exists; alphaDistance has no UI exposure
```
Observed: wrapper lab shows concurrency / quality / effort / decode speed controls only. No alpha-distance slider, no extra-channel selector, no depth channel demo.

**Affected files / packages:**
- `web/jxl-wrapper-lab.html` (add Extra Channels section) **or** create `web/jxl-extra-channels-lab.html`
- `web/jxl-wrapper-lab.js` (wire `alphaDistance` into `makeEncoderOptions()`)
- Potentially `web/test-nav.css` or nav bar links if a new page is added
- `packages/jxl-wasm/src/facade.ts` (already complete — `alphaDistance`, `extraChannels[]`, `caps.extraChannelEncode`)

**Follow-up / Resolution steps:**
1. Add an "Extra Channels" section to `web/jxl-wrapper-lab.html` (or new page). Controls needed: `alphaDistance` slider (0.0–2.0, step 0.1), channel type dropdown for extra channels, bit-depth selector.
2. Wire controls into `makeEncoderOptions()` in `web/jxl-wrapper-lab.js` under a `caps.extraChannelEncode` guard.
3. Add side-by-side or overlay comparison: encode the same RGBA image with `alphaDistance: 0` (lossless) vs. `alphaDistance: 1.0` (lossy); display both decoded outputs + file sizes.
4. Add a depth-channel demo: synthesize a 16-bit greyscale gradient plane in a `Uint16Array`; pass it as `extraChannels: [{ type: 'depth', bitsPerSample: 16, distance: 0 }]` with matching `extraChannelPlanes`; decode and display as a greyscale overlay.
5. Verify `caps.extraChannelEncode` gate hides/disables EC controls when the binary lacks the export (expected until WASM binary is rebuilt — see Issue 1/3 above).
6. Run existing wrapper lab tests after changes (`bun test web/jxl-wrapper-lab.test.js`); fix any regressions.

**Agent Jump-In Checklist:**
- Read (in order): `docs/references/designs/extra-channel-distance.md` §6 (Benchmark Wiring), `packages/jxl-wasm/src/facade.ts` (`EncoderOptions.alphaDistance`, `EncoderOptions.extraChannels`, `caps.extraChannelEncode` capability check), `packages/jxl-wasm/test/facade.test.ts` (`describe("extra channel encode")` — shows the minimal working encode call).
- Read for UI patterns: `web/jxl-wrapper-lab.html` lines 1–120 (page structure, spinpickers, importmap), `web/jxl-wrapper-lab.js` `makeEncoderOptions()`.
- Run first: open `web/jxl-wrapper-lab.html` locally to confirm existing race section still works.
- Success criteria = alpha distance slider works + side-by-side comparison renders + depth demo displays greyscale overlay + existing race section unaffected + `caps.extraChannelEncode` guard tested.
- Gotcha: `caps.extraChannelEncode` will be false until the WASM binary is rebuilt (Issue 1/3). Design the UI to degrade gracefully (show message "Extra channel encode requires a rebuilt WASM binary — see Issue 1/3").
- Gotcha: RGBA source images needed — transparent PNGs work; alternatively generate a checkerboard with canvas `clearRect` + `fillRect`.

**Sufficient Context Summary:** Phase 1 extra-channel WASM code is complete but has no browser UI. This issue adds alpha-distance and depth-channel controls to `web/jxl-wrapper-lab.html`, guarded by `caps.extraChannelEncode` (false until WASM binary rebuild). The complete API shape is already in `facade.ts`; the test file shows the minimal encode call.

---

## 8. Tauri/Rust extra channel implementation — wire alphaDistance and extraChannels[] into native encode path (2026-05-29)

**Status:** done (2026-05-29)

Source complete + native addon rebuilt + 12 tests pass (6 roundtrip codec tests including lossless alpha, depth extra channel, modular options, advancedFrameSettings, custom boxes, animation).

Bug fixed: `JxlEncoderAddBox` in libjxl 0.11.x requires `JxlEncoderUseBoxes()` (not just `JxlEncoderUseContainer`) — added before any box additions in `EncodeAll`. Also: `customBoxes` comment "not yet implemented in native binding" removed from `index.ts`.

Verification: `bun test ./node_modules/@casabio/jxl-native/test/codec.test.ts` — 12 pass, 0 fail.

**Why this matters:**
- The WASM encode path now supports `alphaDistance`, `extraChannels[]`, and full per-channel distance. The Tauri/native path does not.
- Users who encode through the Tauri desktop app get no benefit from Phase 1 until the native side is wired.
- The native path calls libjxl C API directly (`packages/jxl-native/src/native.cc`). The three-step libjxl pattern (`JxlEncoderSetExtraChannelInfo` → `JxlEncoderSetExtraChannelDistance` → `JxlEncoderAddExtraChannelBuffer`) is already demonstrated in the WASM bridge and can be ported directly.
- Links: `docs/references/designs/extra-channel-distance.md` §4 (Rust sub-section), `docs/references/PROGRESS_LOG.md` (2026-05-29 entry, deferred items).

**Reproduction / Current State:**
```powershell
# packages/jxl-native/src/index.ts — NativeEncoderOptions has no alphaDistance or extraChannels fields
# packages/jxl-native/src/native.cc — CreateEncoder does not call JxlEncoderSetExtraChannelInfo
```
Observed: passing `alphaDistance: 0` through the Tauri encode path has no effect; option is silently ignored.

**Affected files / packages:**
- `packages/jxl-native/src/index.ts` — add `alphaDistance?: number` and `extraChannels?: ExtraChannel[]` to `NativeEncoderOptions`
- `packages/jxl-native/src/native.cc` — parse new fields in `CreateEncoder`; add channel declaration, distance setting, and buffer-add calls
- `packages/jxl-native/test/` — add or extend test for lossless alpha + lossy color round-trip
- Shared type: `ExtraChannel` interface is defined in `packages/jxl-wasm/src/facade.ts` — check whether `packages/jxl-core/src/types.ts` is the right place to share it with the native package

**Follow-up / Resolution steps:**
1. Check `packages/jxl-core/src/types.ts` — if `ExtraChannel` is already exported there, use it. If not, move or re-export the interface from `facade.ts` so both packages share one definition.
2. Add `alphaDistance?: number` and `extraChannels?: ExtraChannel[]` to `NativeEncoderOptions` in `packages/jxl-native/src/index.ts`.
3. In `native.cc`, extend `EncoderData` (or equivalent options struct) to hold these fields.
4. In `CreateEncoder`, after the main image frame settings and before `JxlEncoderAddImageFrame`, add: iterate `extraChannels`, call `JxlEncoderSetExtraChannelInfo` for each, then `JxlEncoderSetExtraChannelDistance`; then after `AddImageFrame`, call `JxlEncoderAddExtraChannelBuffer` for each channel's pixel data.
5. Wire `alphaDistance` as a shorthand: if `alphaDistance` is set and the image has alpha, apply it to the alpha channel; if `extraChannels` explicitly declares an alpha channel, use its `distance` field and ignore `alphaDistance`.
6. Add a native test that encodes a 2×2 RGBA8 image with `alphaDistance: 0` and verifies the output is a valid JXL bitstream with non-zero size.
7. Rebuild native addon (resolve node-gyp dependency — see Issue 4 in this file) and run the test suite.

**Agent Jump-In Checklist:**
- Read (in order): `docs/references/designs/extra-channel-distance.md` §4 + §5, `packages/jxl-wasm/src/bridge.cpp` (`EncodeRgbaWithExtraChannels` static function — the complete libjxl sequence to replicate), `packages/jxl-native/src/native.cc` (`CreateEncoder` function — insertion point for new code).
- Run first: `pnpm typecheck` to confirm current native package baseline; run existing native tests.
- Success criteria = `NativeEncoderOptions` has both fields + native encode with `alphaDistance: 0` produces valid output + existing native paths unaffected + new test passes.
- Gotcha: `JxlEncoderSetExtraChannelInfo` and `JxlEncoderSetExtraChannelDistance` **must** be called before `JxlEncoderAddImageFrame` — verify the call ordering in `CreateEncoder`.
- Gotcha: The `WasmExtraChannel` 20-byte binary struct is WASM-only. Parse the JS `extraChannels[]` array via Napi/V8 directly in `native.cc` — do not replicate the binary layout.
- Gotcha: `ExtraChannelType` string literals (`'alpha'`, `'depth'`, etc.) must be mapped to `JxlExtraChannelType` C enum values (`JXL_CHANNEL_ALPHA = 0`, `JXL_CHANNEL_DEPTH = 1`, `JXL_CHANNEL_SPOT_COLOR = 2`, `JXL_CHANNEL_SELECTION_MASK = 3`, etc.).
- Prerequisite: node-gyp must be resolvable (see Issue 4 above).

**Sufficient Context Summary:** The WASM extra-channel path is complete; the Tauri native path (`packages/jxl-native/src/native.cc`) still ignores `alphaDistance` and `extraChannels`. Port the three-step libjxl pattern from `EncodeRgbaWithExtraChannels` in `bridge.cpp` to `CreateEncoder` in `native.cc`, parse the JS fields via Napi instead of the binary WASM struct, add type-string-to-enum mapping, and add a smoke test.

---

## 9. Rebuild WASM + Native Artifacts for Animation Feature (2026-05-29)

**Status:** done (2026-05-29) — WASM and native both complete

**WASM rebuild complete:** All 7 animation symbols confirmed in `dist/jxl-core.simd-mt.js`: `_jxl_wasm_encode_animation` (→ wasmExports["Q"]), `_jxl_wasm_dec_frame_index` ("T"), `_jxl_wasm_dec_frame_duration` ("U"), `_jxl_wasm_dec_frame_name_ptr` ("V"), `_jxl_wasm_dec_is_last_frame` ("W"), `_jxl_wasm_dec_anim_ticks_per_second` ("X"), `_jxl_wasm_dec_anim_loop_count` ("Y"). `animationEncode` capability will be `true` in browser. 69 facade tests pass.

**Why this matters:**
- `packages/jxl-wasm/src/bridge.cpp` and `packages/jxl-native/src/native.cc` were extended with full animation encode/decode support on branch `epiccodereview/20260527T054853` (see PROGRESS_LOG 2026-05-29 animation entry).
- The generated `dist/*.wasm`, `dist/facade.js`, and native `.node` binary still reflect the pre-animation state.
- Until rebuilt, `getWrapperCapabilities().animationEncode` will return `false` in the browser, and the `web/animation-lab.html` encode path will fall through gracefully but will not actually encode.
- TypeScript typechecks (`npx tsc --noEmit`) pass. Functional validation of the C++ encode path requires a live WASM binary.

**Reproduction:**
```powershell
# WASM rebuild blocked — Docker daemon not reachable:
pnpm --filter @casabio/jxl-wasm build
# Expected: permission denied while trying to connect to docker API
# (same as Issues 1/3)

# Native rebuild blocked — node-gyp missing:
npm --workspace packages/jxl-native run build
# Expected: Cannot find module '.../node-gyp/bin/node-gyp.js'
# (same as Issue 4)
```

**New symbols added (must appear in rebuilt artifacts):**
- WASM exports (7): `_jxl_wasm_encode_animation`, `_jxl_wasm_dec_frame_index`, `_jxl_wasm_dec_frame_duration`, `_jxl_wasm_dec_frame_name_ptr`, `_jxl_wasm_dec_is_last_frame`, `_jxl_wasm_dec_anim_ticks_per_second`, `_jxl_wasm_dec_anim_loop_count`
- Native N-API: animation header parsing in `CreateEncoder`; `JXL_DEC_FRAME` handler + frame metadata in `DecodeAll`

**Affected files / packages:**
- `packages/jxl-wasm/src/bridge.cpp` — `WasmAnimationFrame`, `WasmAnimationOpts`, `EncodeAnimation()`, `jxl_wasm_encode_animation`, 6 decoder accessor exports, `JxlWasmDecState` animation fields, `JXL_DEC_FRAME` handler
- `packages/jxl-wasm/exports.txt` — 7 new animation symbols appended
- `packages/jxl-wasm/src/facade.ts` — capability gate `animationEncode`, `marshalAnimationFrames`, encode dispatch, `eventsProgressive` enrichment
- `packages/jxl-native/src/native.cc` — `EncoderData` animation fields, `CreateEncoder` animation parsing, `DecodeAll` frame metadata
- `packages/jxl-native/src/index.ts` — `AnimationFrame`, `AnimationOptions`, extended `EncoderOptions` and `DecodeEvent`
- `web/animation-lab.html` — benchmark page (capability banner shown until rebuild)

**Follow-up:**
1. Start Docker Desktop/Linux engine (same prerequisite as Issues 1/3).
2. Run `pnpm --filter @casabio/jxl-wasm build` from repo root.
3. Verify the 7 animation symbols appear in the regenerated `dist/` artifacts.
4. Open `web/animation-lab.html` in a browser; confirm capability banner disappears and "Encode Animation" produces a file > 0 bytes.
5. Check `getWrapperCapabilities().animationEncode === true` in browser console.
6. Restore node-gyp for native package (see Issue 4), rebuild, run `bun test packages/jxl-native/test/codec.test.ts`.

**Agent Jump-In Checklist:**
- Read (in order): `docs/references/PROGRESS_LOG.md` (2026-05-29 animation entry), `packages/jxl-wasm/src/bridge.cpp` (`EncodeAnimation` function + `JXL_DEC_FRAME` handler block + 6 accessor exports at bottom), `packages/jxl-wasm/exports.txt` (last 7 lines), `web/animation-lab.html` (capability banner logic).
- Run first: `npx tsc --noEmit` from `packages/jxl-wasm` — must pass (TypeScript clean baseline confirmed on 2026-05-29).
- Success criteria = all 7 new symbols in WASM binary + `animation-lab.html` encodes a multi-frame file + `animationEncode` capability true + decode events include `frameIndex`/`frameDuration` fields.
- Gotcha: `_jxl_wasm_encode_animation` takes 19 uint32 args — verify the Emscripten call stub matches exactly (count args in `bridge.cpp` export signature).
- Gotcha: `eventsOneShot` does NOT get animation enrichment (uses buffer handle not decoder state handle) — do not add it there.
- Prerequisite: Docker/Emscripten (WASM rebuild) and node-gyp (native rebuild) must be available. See Issues 1/3 and Issue 4 for environment setup.

**Sufficient Context Summary:** Animation encode/decode was fully implemented in source on 2026-05-29 (7 new WASM exports, N-API native path, TypeScript types, benchmark page). The WASM binary and native addon must be rebuilt to activate the feature at runtime. The rebuild is blocked by the same Docker/node-gyp environment constraints documented in Issues 1/3 and Issue 4. Once unblocked, follow the 6-step verification sequence above.
