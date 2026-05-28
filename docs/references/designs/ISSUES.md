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

Status: blocked until the Docker/Emscripten build path is available in this workspace.

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

Command run:

```powershell
pnpm --filter @casabio/jxl-wasm build
```

Observed failure:

```text
Docker CLI is installed, but the Docker daemon is not reachable. Start Docker Desktop/Linux engine and retry.
permission denied while trying to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine
```

Why this matters:

- `packages/jxl-wasm/src/bridge.cpp` now exports additional `_x` variants for modular / brotli options.
- Generated WASM binaries in `packages/jxl-wasm/dist/*.wasm` must be rebuilt before browser/runtime validation proves the C++ bridge path works end to end.

Follow-up:

1. Start Docker Desktop/Linux engine.
2. Rerun `pnpm --filter @casabio/jxl-wasm build`.
3. Run a smoke test against the facade path that exercises `modular` and `brotliEffort`.

## 4. Rebuild Native Addon

Status: blocked in current environment.

Command run:

```powershell
rtk npm --workspace packages/jxl-native run build
```

Observed failure:

```text
Cannot find module 'C:\Foo\raw-converter-wasm\packages\jxl-native\node_modules\node-gyp\bin\node-gyp.js'
```

Why this matters:

- `packages/jxl-native/src/native.cc` now parses `resampling` and applies `JXL_ENC_FRAME_SETTING_RESAMPLING`.
- Native binary rebuild is required before Node/N-API runtime validation.

Follow-up:

1. Restore/install `packages/jxl-native` dependencies so `node-gyp` exists locally, or update the build script to use the workspace/root `node-gyp`.
2. Rerun `rtk npm --workspace packages/jxl-native run build`.
3. Add or run a native encode/decode smoke test with `resampling: 2`.

## 5. Existing Full Facade Test Failure

Status: unrelated pre-existing test expectation failure.

Command run:

```powershell
rtk bun test packages/jxl-wasm/test/facade.test.ts
```

Observed failure:

```text
detectTier > returns scalar in Node/Bun (no cross-origin isolation)
Expected: "scalar"
Received: "simd-mt"
```

Why this matters:

- Focused resampling tests pass, but full facade suite remains red due this tier-detection expectation.
- Current Node/Bun environment exposes capabilities that make `detectTier()` return `simd-mt`.

Follow-up:

1. Decide whether Node/Bun should force scalar or allow threaded/SIMD tier detection.
2. Update test or implementation accordingly.
3. Rerun full `packages/jxl-wasm/test/facade.test.ts`.

## 6. Existing Wrapper Lab Test Failure

Status: unrelated pre-existing test/page mismatch.

Command run:

```powershell
rtk bun test web/jxl-wrapper-lab.test.js
```

Observed failure:

```text
Expected to contain: "data-mode=\"compare\""
```

Why this matters:

- Current `web/jxl-wrapper-lab.html` has `race`, `existing`, and `wrapper` mode buttons, but no `compare` button.
- Resampling UI was added successfully to the page, but this stale expectation keeps the test red.

Follow-up:

1. Decide whether `compare` mode should return or whether test should reflect current modes.
2. Update `web/jxl-wrapper-lab.test.js` or `web/jxl-wrapper-lab.html`.
3. Rerun wrapper lab tests.

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
