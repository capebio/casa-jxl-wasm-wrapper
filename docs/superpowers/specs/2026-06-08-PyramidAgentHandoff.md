# PyramidAgentHandoff.md

**Source:** `2026-06-07-pyramid-gallery-design.md`  
**Date:** 2026-06-08  
**Purpose:** Assign implementation work for the Pyramid Gallery Pipeline across available coding agents, with explicit effort levels, ownership boundaries, and review gates.

---

## 1. Executive Summary

The Pyramid Gallery Pipeline should be implemented as a staged delivery, not as one large feature branch. The design has a clean milestone structure:

- **M0:** WASM bridge primitives and per-level sidecar distances.
- **M1:** 8-bit ingest CLI, content-addressed levels, manifest/index, proxy mode, and gallery grid seed/upgrade.
- **M2:** 8-bit lightbox with zoom/pan, adjustment presets, sliders, and histogram.
- **M3:** 16-bit RAW path, WebGL float adjustment, Floyd-Steinberg dither, and ROI crop export.
- **M4:** Massive-scan tiled top level and parallel ROI decode.

Given the available agents:

- **Grok Build** should own all correctness-critical implementation: WASM bridge changes, ingest pipeline, scheduler integration, gallery grid decode path, lightbox architecture, 16-bit path, ROI, and final integration.
- **Gemini** should be used only for low-risk, deterministic, copy-and-paste-heavy tasks: schema scaffolding, constant tables, fixture lists, test matrices, README sections, checklists, manifest examples, and clerical refactors that are easy to inspect.
- **Human/David** should act as product owner and final acceptance reviewer, especially for visual behaviour, perceived speed, image quality, and whether the lightbox feels like the CasaBio model.
- **Claude/ChatGPT-style reviewer**, if available, should be used as a skeptical reviewer before merging each milestone, particularly to detect over-engineering, violation of existing pipeline invariants, or accidental duplication of scheduler/cache/backpressure layers.

The highest-risk implementation work is M0/M1. If those are wrong, every later layer will inherit bad assumptions. Therefore M0 and M1 should be assigned to Grok Build at high effort, with Gemini kept out of core code except for generated test tables and documentation.

---

## 2. Agent Roles

### 2.1 Grok Build — Primary Implementer

**Use for:** difficult code, performance-sensitive code, WASM/C++/Rust/TypeScript integration, scheduler integration, and all changes where a subtle bug could corrupt image output or architecture.

**Effort level:** High for M0, M1, M3, M4. Medium-high for M2.

**Responsibilities:**

1. Implement bridge changes and WASM exports.
2. Implement the Node ingest CLI.
3. Integrate existing scheduler/cache/pool/worker packages without inventing duplicate layers.
4. Implement the gallery grid seed/upgrade path.
5. Implement the lightbox architecture.
6. Implement 16-bit RAW/WebGL path when M3 is reached.
7. Implement tiled/ROI decode only when M4 is reached.
8. Write or finalize correctness tests where behaviour is subtle.
9. Make performance-sensitive choices and justify them.
10. Keep every milestone shippable and independently testable.

**Restrictions:**

- Must not implement server-side resize/transform logic.
- Must not use `sharp` or native image dependencies for ingest.
- Must not add a second scheduler, cache, worker pool, or backpressure layer.
- Must not implement 16-bit RAW big levels in M1; that belongs to M3.
- Must not make CI or runtime depend on `C:\Users\User\AndroidStudioProjects\CplusplusTest\`; that path is documentation only.

---

### 2.2 Gemini — Clerical Assistant Only

**Use for:** safe, bounded, deterministic work that can be reviewed quickly.

**Effort level:** Low to medium. Do not give it architecture authority.

**Good Gemini tasks:**

1. Convert manifest examples into TypeScript interfaces.
2. Create fixture arrays from the supplied fixture list.
3. Write markdown documentation sections from already-approved spec text.
4. Generate test-case matrices from explicit requirements.
5. Create enum/constant files for level sizes, format names, preset names, and quality distances.
6. Add basic README usage examples.
7. Prepare checklist files for M0–M4.
8. Write simple snapshot tests for schema shape once Grok has defined the canonical interface.
9. Copy FilterEngine preset names into a constant table, without inventing matrix math.
10. Draft comments for existing code where the behaviour is already known.

**Bad Gemini tasks:**

1. Do not let Gemini alter `bridge.cpp` encoding logic.
2. Do not let Gemini alter WASM memory ownership/lifetime logic.
3. Do not let Gemini implement the scheduler integration.
4. Do not let Gemini implement decode cancellation semantics.
5. Do not let Gemini implement RAW/JPEG orientation handling.
6. Do not let Gemini implement 16-bit WebGL processing.
7. Do not let Gemini implement ROI decode.
8. Do not let Gemini make architecture decisions.
9. Do not let Gemini “simplify” the existing 5/5-optimized pipeline.
10. Do not let Gemini refactor working performance-critical code without a narrowly scoped patch.

**Gemini prompt style:**

Give Gemini small, closed tasks with explicit input and expected output. Avoid open-ended prompts such as “improve this”, “optimize this”, “design this”, or “implement the pipeline”.

Preferred pattern:

```text
Create a TypeScript file containing only the constants and interfaces below. Do not add logic. Do not change names. Do not infer new fields. Return a patch only.
```

---

### 2.3 Human / David — Product Owner and Visual Acceptance

**Use for:** decisions that require judgement rather than code.

**Effort level:** Targeted review after each milestone.

**Responsibilities:**

1. Confirm that gallery behaviour feels fast enough.
2. Confirm that level transitions look acceptable.
3. Confirm desired quality split: q85 for small levels, q95 for 2048/full.
4. Confirm whether proxy mode sizes 256/512/1024 are sufficient for field verification.
5. Compare 8-bit vs 16-bit RAW lightbox results when M3 lands.
6. Confirm that the CasaBio lightbox interaction model has been ported faithfully.
7. Decide whether M4 is worth building immediately or should remain deferred until massive scans become a real bottleneck.

---

### 2.4 Independent Reviewer — Claude/ChatGPT/Grok Second Pass

**Use for:** pre-merge review and architecture sanity checks.

**Effort level:** Medium for each milestone, high for M0/M1/M3.

**Review duties:**

1. Check that the implementation matches the design spec exactly.
2. Check that M1 remains 8-bit only.
3. Check that 2048 uses q95/distance 0.55 and is not clamped back to 1.5.
4. Check that JPG full level is lossless transcode, not re-encoded.
5. Check that the client uses one-shot decode through the scheduler, not a parallel ad hoc path.
6. Check that no server-side image logic has been introduced.
7. Check that no external CasaBio Android path is required at build/runtime.
8. Check for needless abstractions, duplicate queues, duplicate caches, and hidden non-goals.

---

## 3. Milestone-by-Milestone Assignment

## M0 — WASM Bridge Primitives

**Scope:** Per-level-distance sidecar pyramid with no harmful floor; 16-bit area-box downscale primitives prepared for later M3 use.

**Primary agent:** Grok Build  
**Effort level:** High  
**Gemini role:** Documentation/test-matrix only  
**Human review:** Required before M1 begins

### Grok Build tasks

1. Modify `bridge.cpp` sidecar encode path so sidecar distances are accepted per level.
2. Remove or parameterize the old sidecar quality floor so 2048 can encode at distance 0.55.
3. Preserve q85/distance 1.45 behaviour for 256/512/1024.
4. Keep the existing cascade downscale path in C++.
5. Add or expose 16-bit downscale primitives only as planned primitives; do not wire M1 to them.
6. Rebuild WASM using the existing build chain.
7. Add tests proving that per-level distances are honoured.
8. Add a regression test specifically proving that 2048 is not clamped to 1.5.

### Gemini tasks

1. Create a markdown checklist for M0 acceptance.
2. Create a table mapping q values to distances:
   - q85 → 1.45
   - q95 → 0.55
   - JPG full → lossless/distance 0
3. Draft documentation for the sidecar quality-floor change, using only approved spec text.

### Acceptance gates

- 2048 sidecar encodes at distance 0.55.
- 256/512/1024 encode at distance 1.45.
- Full RAW level can use q95/distance 0.55 in M1.
- JPG full remains planned as lossless transcode.
- No JS-side cascade is introduced.
- No new scheduler/cache/backpressure layer appears.

---

## M1 — 8-bit Ingest CLI + Gallery Grid

**Scope:** Node ingest CLI, content-addressed 8-bit levels, manifest/index, proxy mode, and gallery grid seed/upgrade.

**Primary agent:** Grok Build  
**Effort level:** High  
**Gemini role:** Schema, fixtures, docs, simple test matrices  
**Human review:** Required before M2 begins

### Grok Build tasks — Ingest

1. Implement a Node CLI that ingests ORF/DNG/CR2/JPG.
2. For RAW, call existing `process_orf_with_flags`, `process_dng_with_flags`, or `process_cr2_with_flags`, then use `ProcessResult.take_rgba()`.
3. For JPG, use lossless `transcodeJpegToJxl` for the full level.
4. Decode the JPG full JXL once to RGBA only for smaller levels.
5. Generate level sizes `[256, 512, 1024, 2048] + full`, skipping levels that would upscale.
6. Use one `encode_rgba8_with_sidecars` call for the 8-bit ladder.
7. Set per-level quality:
   - 256/512/1024: q85/distance 1.45.
   - 2048/full: q95/distance 0.55.
   - JPG full: lossless transcode.
8. Use effort 3.
9. Write `levels/{hash16}.jxl`, `images/{imageId}/manifest.json`, and `index.json`.
10. Use SHA-256 first 16 lowercase hex chars for level content hashes.
11. Use SHA-256 first 16 lowercase hex chars of absolute master path for `imageId`.
12. Implement atomic manifest writes: temp → rename.
13. Implement resumability: skip if manifest exists and master mtime is unchanged.
14. Implement `--proxy <256|512|1024>`, default 512.
15. Implement `--shard i/N` and `--reindex-only` behaviour so concurrent index writers do not race.
16. Keep M1 entirely 8-bit. Do not expose or use RAW RGB16 yet.

### Grok Build tasks — Gallery Grid

1. Fetch `index.json` once.
2. Lay out the grid from aspect ratio before image bytes arrive.
3. Fetch and decode L0 seed level first.
4. Pick upgrade level by `tileSize × devicePixelRatio`.
5. Decode one-shot `_jxl_wasm_decode_rgba8` through the existing scheduler.
6. Use contenthash as the scheduler/cache dedupe key.
7. Implement monotonic upgrades: never downgrade a tile after a higher level has painted.
8. Decode only viewport + prefetch ring.
9. Cancel offscreen jobs before start via scheduler.
10. Crossfade upgrades.
11. Reuse in-memory LRU and OPFS cache.

### Gemini tasks

1. Create TypeScript interfaces for `manifest.json` and `index.json`.
2. Create constants for:
   - level sizes `[256, 512, 1024, 2048]`
   - allowed formats `orf|dng|cr2|jpg`
   - orientation values `baked|source`
   - proxy sizes `256|512|1024`
3. Create fixture lists from the approved fixture paths.
4. Generate test matrix markdown for:
   - skip-upscale behaviour
   - RAW/JPG orientation
   - proxy mode
   - manifest/index schema
   - mtime resumability
   - corrupt file isolation
5. Write README usage examples for CLI commands once Grok defines final command syntax.

### Acceptance gates

- RAW and JPG masters produce correct M1 8-bit manifests.
- Every M1 level has `bitsPerSample: 8`.
- JPG full is lossless transcode.
- Proxy mode emits exactly one level and `proxy: true`.
- Proxy mode does not push and does not add an `index.json` entry.
- Gallery seeds from `index.json` in one round-trip.
- Grid layout has no layout shift.
- Upgrade path uses the scheduler rather than a second decode queue.
- Offscreen decode cancellation works before decode start.
- No server image logic exists.

---

## M2 — 8-bit Lightbox

**Scope:** Lightbox viewing model, zoom ladder, pan, presets/sliders, and live histogram in the 8-bit path.

**Primary agent:** Grok Build  
**Effort level:** Medium-high  
**Gemini role:** Preset-name constants, UI labels, docs, basic tests  
**Human review:** Required for visual feel

### Grok Build tasks

1. Implement lightbox level selection by `screenLongEdge × DPR`.
2. Implement zoom ladder: lower level → higher level → full.
3. Implement crossfade on level upgrade.
4. Implement pan via canvas transform with no re-decode until zoom level changes.
5. Implement live zoom percentage readout.
6. Use scheduler priorities for current image vs prefetch images.
7. Use screen-bitmap LRU.
8. Transcribe CasaBio FilterEngine matrix and slider logic into the repo.
9. Add unit tests for FilterEngine parity.
10. Implement presets:
    - BW
    - BW_HIGH
    - BW_SOFT
    - SEPIA
    - INVERT
    - BOTANICAL
    - WARM
    - COOL
    - DEHAZE
    - BLUEPRINT
    - CHLOROPHYLL
    - NONE
11. Implement parameters:
    - brightness
    - contrast
    - saturation
    - shadows
    - highlights
    - clarity
    - dehaze
    - sharpness
12. Implement live histogram.
13. Ensure no CI/build/runtime dependency on the external Android project path.
14. Explicitly avoid porting annotations, video, taxonomy, or messaging.

### Gemini tasks

1. Create preset enum/constant tables.
2. Create slider label/help text.
3. Create a manual QA checklist for lightbox behaviour.
4. Write README documentation for lightbox controls after Grok finalizes behaviour.
5. Generate basic tests that assert all preset names exist and no unsupported preset is exposed.

### Acceptance gates

- Lightbox can open from grid.
- Zoom ladder upgrades smoothly.
- Panning does not trigger needless re-decodes.
- Presets and sliders match CasaBio FilterEngine behaviour.
- Histogram updates live.
- No Android project path is required by build, CI, or runtime.
- Excluded CasaBio extras remain excluded.

---

## M3 — 16-bit RAW Path + WebGL Float Adjust + ROI Crop Export

**Scope:** RAW big levels `{2048, full}` become 16-bit; client decodes 16-bit levels into WebGL float adjustment path; display is dithered to 8-bit; ROI crop export works.

**Primary agent:** Grok Build  
**Effort level:** Very high  
**Gemini role:** Documentation and matrix tests only  
**Human review:** Required with RAW comparison images

### Grok Build tasks

1. Modify `src/lib.rs` to expose the internal full-resolution RGB16 buffer.
2. Implement or expose `BoxDownscaleRgba16` and `_jxl_wasm_downscale_rgba16` if not already available.
3. Update ingest so RAW `{2048, full}` levels are emitted as 16-bit.
4. Keep RAW grid levels `{256, 512, 1024}` 8-bit.
5. Keep JPG levels always 8-bit.
6. Ensure `bitsPerSample` varies per level without a schema bump.
7. Implement client detection of 16-bit availability.
8. Add a RAW-only 16-bit toggle, off by default.
9. Decode 16-bit level into WebGL float texture.
10. Apply highlight/shadow recovery in float space.
11. Dither 16→8 output via Floyd-Steinberg for display.
12. Preserve 16-bit output for export where applicable.
13. Implement crop-to-feature ROI export using `decodeRegionLod` or relevant region decode path.
14. Make JPG fallback explicit when 16-bit is requested but unavailable.

### Gemini tasks

1. Write a test matrix for RAW vs JPG bit-depth behaviour.
2. Write user-facing help text explaining the 16-bit toggle.
3. Draft documentation explaining why 16-bit is RAW-only.
4. Create fixtures checklist for before/after highlight recovery comparisons.

### Acceptance gates

- M3 does not change manifest schema version.
- RAW 2048/full levels can be 16-bit.
- RAW 256/512/1024 remain 8-bit.
- JPG remains 8-bit only.
- 16-bit toggle is absent or disabled for JPG images.
- WebGL path shows visible highlight/shadow recovery on suitable RAW files.
- Dithered display avoids obvious banding.
- ROI export works and is bounded to the requested crop/window.

---

## M4 — Massive Scans and Tiled Top Level

**Scope:** For masters above threshold, top level becomes JXTC tiled container with ROI decode. Built last.

**Primary agent:** Grok Build  
**Effort level:** High  
**Gemini role:** Documentation, threshold tests, UI/help copy  
**Human review:** Required only if massive scans are an immediate use case

### Grok Build tasks

1. Implement threshold gate: master long edge > ~8000 px or > ~40 MP.
2. Encode top level as JXTC tile container for qualifying masters.
3. Implement `LevelSource` abstraction:
   - whole-frame level source
   - tiled level source
4. Implement parallel ROI decode for tiled levels where COOP/COEP and MT are available.
5. Implement sequential tile decode fallback where MT is unavailable.
6. Keep v1 tiled path rgba8 only unless a later rebuild adds rgba16 tile-container exports.
7. Ensure normal images are not forced into tiled complexity.
8. Avoid true gigapixel source-tiled ingest in v1.

### Gemini tasks

1. Create threshold test table.
2. Draft docs explaining why tiling is only for massive scans.
3. Draft UI/help copy for ROI crop/export.
4. Create a manual QA checklist for tiled vs whole-frame behaviour.

### Acceptance gates

- Non-massive images remain whole-frame.
- Massive images get tiled top level.
- ROI decode cost scales with visible/requested area.
- Client treats whole-frame and tiled levels through the same `LevelSource` interface.
- Non-MT fallback still works.
- No 16-bit tiled promise is made in v1.

---

## 4. Recommended Branching Strategy

Use one feature branch per milestone or sub-milestone:

```text
feat/pyramid-m0-wasm-primitives
feat/pyramid-m1-ingest-cli
feat/pyramid-m1-gallery-grid
feat/pyramid-m2-lightbox-8bit
feat/pyramid-m3-raw16-webgl-roi
feat/pyramid-m4-jxtc-tiling
```

For M1, splitting ingest and grid is sensible because each is independently testable:

- `feat/pyramid-m1-ingest-cli`
- `feat/pyramid-m1-gallery-grid`

Do not start M3 before M1 and M2 are stable. Do not start M4 unless there is a real massive-scan fixture to test against.

---

## 5. Effort-Level Table

| Milestone | Primary Owner | Grok Effort | Gemini Effort | Risk | Merge Gate |
|---|---:|---:|---:|---:|---|
| M0 WASM primitives | Grok Build | High | Low | Very high | Distance/floor tests pass |
| M1 ingest CLI | Grok Build | High | Medium | Very high | Correct 8-bit manifests + proxy |
| M1 gallery grid | Grok Build | High | Low | High | Fast L0 seed + monotonic upgrade |
| M2 lightbox 8-bit | Grok Build | Medium-high | Medium | Medium-high | FilterEngine parity + visual acceptance |
| M3 RAW16/WebGL/ROI | Grok Build | Very high | Low | Very high | RAW16 recovery visible + tests pass |
| M4 JXTC tiling | Grok Build | High | Low | High | Massive-scan ROI works |
| Documentation | Gemini | Low | Medium | Low | Human review |
| Fixture/test matrix generation | Gemini | Low | Medium | Low-medium | Grok verifies before use |

---

## 6. Work That Must Not Be Delegated to Gemini

Do not assign Gemini any of the following:

1. `bridge.cpp` memory management or encoding changes.
2. Any change to `encode_rgba8_with_sidecars` behaviour.
3. Any change to RAW pipeline exports.
4. Any change to WASM build scripts beyond documentation.
5. Scheduler/cancellation implementation.
6. OPFS cache or LRU implementation.
7. Worker pool implementation.
8. WebGL float pipeline.
9. Floyd-Steinberg dither implementation.
10. ROI decode implementation.
11. Orientation handling.
12. Content-hash correctness.
13. Atomic write/resumability logic.
14. Any performance-sensitive refactor.
15. Any “cleanup” of existing optimized layers.

Gemini may generate support files around these areas, but Grok must own the code.

---

## 7. Safe Gemini Task Queue

These can be handed to Gemini immediately.

### Task G1 — Manifest and Index Types

```text
Create a TypeScript file defining interfaces for the Pyramid Gallery manifest and index schemas. Use only these fields: schema, imageId, master, orientation, width, height, aspect, levels, proxy, images, l0. Do not add logic. Do not invent fields. Include union types for size, format, and orientation.
```

### Task G2 — Constants

```text
Create a TypeScript constants file for pyramid level sizes, proxy sizes, image formats, orientation values, and quality distances. Do not add functions except a simple constant lookup object. Do not implement encoding logic.
```

### Task G3 — Fixture List

```text
Create a fixture metadata file containing the approved fixture paths from the design document. Preserve exact paths as strings. Do not check file existence. Do not modify path spelling.
```

### Task G4 — M1 Test Matrix Markdown

```text
Create a markdown test matrix for M1 ingest covering level selection, skip-upscale, RAW/JPG orientation, bitsPerSample=8, proxy mode, content hashes, resumability, corrupt file isolation, and manifest/index schema. Do not write executable tests.
```

### Task G5 — Lightbox Preset Constants

```text
Create a TypeScript enum or const object for the approved lightbox preset names only. Do not implement color matrices. Do not invent additional presets.
```

### Task G6 — README Draft

```text
Draft README sections for the Pyramid Gallery Pipeline using only the approved spec. Include topology, ingest command placeholders, output layout, manifest/index explanation, proxy mode, and milestone status. Mark command syntax as pending until confirmed by Grok Build.
```

---

## 8. Prompts for Grok Build

### Prompt GB-M0

```text
Implement M0 of the Pyramid Gallery Pipeline.

You are responsible for the correctness-critical WASM bridge changes. Modify the sidecar pyramid encode path so it accepts per-level distances and does not clamp the 2048 sidecar back to distance 1.5. Preserve q85/distance 1.45 for 256/512/1024 and allow q95/distance 0.55 for 2048/full. Keep cascade downscale inside C++ and avoid JS-side cascade. Add regression tests proving each level uses its requested distance.

Do not implement M1 ingest yet. Do not wire 16-bit RAW levels into ingest. Do not add any new scheduler/cache/backpressure layer.

Return a patch plus a short explanation of exactly how the old floor was changed and how the tests prove it.
```

### Prompt GB-M1-Ingest

```text
Implement M1 ingest for the Pyramid Gallery Pipeline.

Build a pure-WASM Node CLI that ingests ORF/DNG/CR2/JPG and emits content-addressed 8-bit JXL levels, per-image manifest.json, and gallery index.json. RAW must use existing process_*_with_flags exports and ProcessResult.take_rgba(). JPG full must be lossless transcode; decode that JXL once only to build smaller levels. M1 is entirely 8-bit for every level and every format.

Levels are [256,512,1024,2048]+full, skipping upscales. Distances: 256/512/1024 = 1.45; 2048/full = 0.55; JPG full = lossless. effort=3. Use one encode_rgba8_with_sidecars call for the 8-bit ladder. Implement hash16 names, atomic manifest writes, resumability by mtime, --proxy default 512, --shard i/N, and --reindex-only.

Do not use sharp. Do not add server-side image logic. Do not implement RAW16. Return patch and tests.
```

### Prompt GB-M1-Grid

```text
Implement M1 gallery grid.

The grid fetches index.json, lays out images using aspect before bytes arrive, decodes L0 seed first, then upgrades to the DPR-right-sized level. Use one-shot _jxl_wasm_decode_rgba8 through the existing scheduler, with contenthash as dedupe key. Reuse existing in-memory LRU and OPFS cache. Implement viewport + prefetch-ring laziness, cancel-before-start for offscreen decodes, monotonic upgrade with no downgrade, and crossfade.

Do not create a second decode queue, scheduler, cache, or worker abstraction. Do not use native <img>.jxl except as static fallback. Return patch and tests.
```

### Prompt GB-M2

```text
Implement M2 lightbox 8-bit.

Port the CasaBio interaction and adjustment model into this repo. The external Android path is documentation only and must not be used by CI/build/runtime. Implement level selection by screenLongEdge×DPR, zoom ladder, crossfade, pan via canvas transform, live zoom percentage, current-vs-prefetch scheduler priority, screen-bitmap LRU, FilterEngine preset/slider parity, and live histogram.

Do not port annotations, video, taxonomy, or messaging. Do not implement RAW16 yet. Return patch, tests, and a short parity note for FilterEngine behaviour.
```

### Prompt GB-M3

```text
Implement M3 RAW16/WebGL/ROI.

Expose the Rust RAW pipeline's internal full-resolution RGB16 buffer, emit RAW 2048/full levels as 16-bit, keep RAW 256/512/1024 as 8-bit, and keep JPG always 8-bit. No manifest schema bump should be needed because bitsPerSample is per level.

Implement RAW-only 16-bit toggle, decode16 to WebGL float texture, float-space highlight/shadow adjustment, Floyd-Steinberg 16→8 display dither, and ROI crop export. If a JPG image requests 16-bit, fall back explicitly to 8-bit.

Return patch, tests, and before/after comparison instructions using RAW fixtures.
```

### Prompt GB-M4

```text
Implement M4 massive-scan tiling.

Only masters with long edge > ~8000 px or > ~40 MP should get a JXTC tiled top level. Implement LevelSource abstraction so the client treats whole-frame and tiled levels uniformly. Implement parallel ROI decode where MT is available and sequential fallback where COOP/COEP or MT is unavailable. Keep v1 tiling rgba8 only. Do not implement source-tiled gigapixel ingest.

Return patch and tests using a massive-scan fixture.
```

---

## 9. Review Checklist Before Each Merge

Use this before merging any milestone branch.

### Architecture invariants

- [ ] No server-side resize or transform endpoint.
- [ ] No `sharp` dependency.
- [ ] No within-image DC progressive path added.
- [ ] No new scheduler/cache/backpressure layer.
- [ ] Existing scheduler/cache/pool/worker packages are reused.
- [ ] No CI/build/runtime dependency on external CasaBio Android path.
- [ ] No M3 features accidentally shipped in M1.
- [ ] No M4 tiling complexity applied to ordinary images.

### Image pipeline invariants

- [ ] RAW decode happens once at ingest, never per view.
- [ ] M1 levels are all 8-bit.
- [ ] RAW orientation is baked.
- [ ] JPG orientation remains source/EXIF-preserving.
- [ ] JPG full level is lossless transcode.
- [ ] 256/512/1024 use q85/distance 1.45.
- [ ] 2048/full use q95/distance 0.55 where applicable.
- [ ] 2048 sidecar is not clamped to 1.5.
- [ ] Level sizes skip upscales.
- [ ] Contenthash is SHA-256 first 16 lowercase hex chars of JXL bytes.

### Client invariants

- [ ] Grid uses `index.json` for first layout.
- [ ] L0 seed paints first.
- [ ] Upgrade level is chosen by display size × DPR.
- [ ] Decode jobs go through scheduler.
- [ ] Contenthash is the dedupe key.
- [ ] Tiles do not downgrade after a higher level paints.
- [ ] Offscreen decodes are cancelled before start.
- [ ] Pan does not cause needless re-decodes.
- [ ] Lightbox does not port excluded CasaBio features.

---

## 10. Suggested Implementation Order

1. **M0 first.** Do not begin ingest until per-level distances are correct.
2. **M1 ingest second.** Validate output files before building UI around them.
3. **M1 gallery grid third.** Use real M1 outputs.
4. **M2 lightbox fourth.** Build the 8-bit viewer before 16-bit complexity.
5. **M3 RAW16 fifth.** Only after the lightbox interaction model works.
6. **M4 tiling last.** Only if massive scans are actively needed.

This order avoids the two biggest traps:

- Building a beautiful client around incorrect pyramid outputs.
- Building the 16-bit/tiled future before the fast 8-bit gallery is working.

---

## 11. Documents That Would Help

The supplied design spec is enough to produce this handoff and begin agent assignment. For actual coding, the following documents would materially improve accuracy:

1. **Plan A — `2026-06-07-pyramid-wasm-primitives.md`**
   - Needed before Grok edits the WASM bridge.
2. **Plan B — ingest plan**
   - Needed before Grok implements the CLI.
3. **Plan C — gallery grid plan**
   - Needed before Grok wires scheduler/cache/UI behaviour.
4. **Plan D1/D2 — lightbox plans**
   - Needed before implementing FilterEngine parity, 16-bit toggle, and ROI.
5. **Plan E — massive-scan tiling plan**
   - Needed only when M4 becomes active.
6. **CLAUDE.md and rejected-optimizations logs**
   - Useful as guardrails to prevent agents from reintroducing rejected abstractions or violating pipeline invariants.

Recommendation: provide Plan A and Plan B before asking Grok to implement M0/M1. Plan C can follow immediately after M1 ingest produces sample outputs. Plans D and E can wait.

---

## 12. Final Recommendation

Use Grok Build as the only trusted implementation agent for the actual pipeline. Use Gemini as a fenced clerical worker. Make every Gemini output pass through Grok or human review before it touches production code.

The best immediate next step is:

1. Give **Grok Build** the GB-M0 prompt with Plan A.
2. Give **Gemini** tasks G1–G4.
3. Review M0 outputs carefully.
4. Only then give Grok GB-M1-Ingest with Plan B.

The most important rule is to keep M1 boring and correct: a pure-WASM, all-8-bit, content-addressed pyramid with accurate per-level distances and a fast grid. The 16-bit and tiled work are valuable, but they should not be allowed to destabilize the first shippable gallery.
