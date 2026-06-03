# Incomplete Plans & Outstanding Action Items

This document consolidates the remaining tasks, goals, and follow-ups from various handoff and plan documents across the repository.

## Environment & Build Issues (`issues.md`)
- [x] **Rebuild WASM Artifacts:** Built 2026-06-03T15:07 UTC via Docker (emscripten 4.0.13). `_jxl_wasm_dec_create` exported and functional — `progressive-detail.test.ts` asserts `eventTypes.length >= 3` (VarDCT Dc=2+group=1 noise source, 10/10 pass). Bench `paints=1` on small real photos is expected behavior (cutoff probe rarely sees an intermediate paint on 300×225 images), not a binary defect.
- [x] **Rebuild Native Addon:** `npx node-gyp rebuild` from `packages/jxl-native/` succeeded (MSVC, 2026-06-03). Binary at `packages/jxl-native/build/Release/jxl_native.node`. All 9 native facade tests pass.
- [x] **Fix Full Facade Test Failure:** `packages/jxl-wasm/test/facade.test.ts` — 88 pass / 0 fail as of 2026-06-03. Was stale entry.
- [x] **Fix Wrapper Lab Test Failure:** `web/jxl-wrapper-lab.test.js` — 1 pass / 0 fail as of 2026-06-03. Was stale entry.

## P3 Lightbox JXL Decoder (handoff archived at `docs/Completed plans/Archived_handoff-p3-lightbox-jxl-decoder.md`)
- [x] **P3.2 — Viewport / ROI Awareness:** `computeLightboxVisibleRegion()` + `roi.region` wired into `jxlOpts` in `drawLightboxForCard`. ROI re-decode triggered on zoom/pan. All on `feature/p3.1-lightbox-jxl-progressive-decoder` branch.
- [x] **P3.3 — JXL Container Previews + JXTC + Polish:** `previewFirst` container preview (DC + JXTC recon JPEG fast path), strategy badges with detail/stage echo, animated JXL metadata, multi-frame `frameIndex` wiring. Delivered across 15+ commits on feature branch. Remaining: full multi-frame nav scrub (follow-up, lower ROI — see `docs/Completed plans/2026-06-p3-lightbox-jxl-progressive-decoder.md`).

## P3.1 Lightbox Progressive Decoder (handoff archived at `docs/Completed plans/Archived_2026-06-p3.1-remaining-tasks-5-6-7.md`)
- [x] **Task 5 (Update Call Sites):** All 8 `pool.decodeJxl` call sites in `web/main.js` on branch `feature/p3.1-lightbox-jxl-progressive-decoder` have priority + `{ progressive, cachePolicy }` args. Verified 2026-06-03.
- [ ] **Task 6 (Verification):** Requires live browser + Tauri. Manual check: progressive first paint, `'onFirstProgress'` slider, `'onFinal'` prefetch, jsquash fallback, no regressions. Cannot automate.
- [x] **Task 7 (Polish):** No `TODO P3` markers remain. NOTE comment at `main.js:586` accurate. `docs/lightbox-impl-decisions.md` line 116 records P3.1 live. Done.

## Tauri Optimization: Predator Mode (`docs/HANDOFF-tauri-predator-mode.md`)
- [ ] **Image Pipeline Hot Paths:** Hunt for inefficiencies in thumbnail/lightbox generation paths. Optimize downscaling, unsharp masking, and tone mapping with manual loops and integer paths.
- [ ] **Boundary Cost Audit (Desktop):** Trace data flows to eliminate unnecessary buffer copies/handoffs. Focus on priority semaphores, gallery rendering, OPFS-like caches, and IPC command boundaries.

## Progressive Encode & Decode Predator Mode (`docs/HANDOFF-predator-progressive-2026.md`)
- [x] **Measurement & A/B Testing (ref run + numbers):** 2026-06-03 predator-progressive-metrics run on small_file.jpg (300×225 q85) captured 18-cell Dc×group×effort data (encodeMs, size, progressEvents=2 always, first* bytes/ms). Numbers + analysis fed to HANDOFF continuation, suggested-settings.md, boundary-cost-audit.md, and reference-small-matrix-report.md (new section). Decode collection now also wired in correlation matrix worker (so page sweeps produce the layer metrics). Full visual A/B ("first recognizable" spatial quality on paint page for g=0 vs 1) + larger refs (Gobabeb) + prefix-probe for true early bytes remain.
  - See `docs/HANDOFF-predator-continuation-2026-06-encode-matrix.md` (the measurement run results block + remaining next steps: visual confirmation in paint page, Tauri equivalent, report updates — some docs now done).
- [ ] **Tauri Parity:** Wire the new `encode_variants_with_progressive` to provide progressive output for the desktop gallery/lightbox. (encode_variants_with_progressive with dc/group already present in crates/raw-pipeline/src/casabio_encode.rs; sibling Tauri app + matrix bench integration pending.)
- [x] **Test/Heuristics Polish (CSV/JSON export):** Paint tool has `exportMeasurementsCSV()`, `exportMeasurementsJSON()`, `exportMeasurementsTOON()` (all wired to buttons, emitting structured per-run data including preset, throttle, paints, timing). Benchmark scripts write JSON to `docs/Benchmark results/`. Matrix worker carries Dc/group columns.
- [ ] **Test/Heuristics Polish (prefix-probe):** Prefix-probe enhancement for true "min bytes to first progress" (byte-cutoff probe with 8-20 prefixes per file) gives more accurate firstProgressBytes than chunk-streaming. WASM rebuild done (2026-06-03); blocker was incorrect. Wire probe loop into bench script — lower priority.

## Tauri / WASM Parity (`docs/HANDOFF-tauri-parity-2026-06-03.md` — active on tauriparity branch; see also archived `docs/Completed plans/Archived_HANDOFF-tauri-wasm-parity-2026.md`)
- [x] **Encode (RAW → JXL):** Implement a direct-RGBA production path inside `crates/raw-pipeline` (bypassing intermediate RGB arrays). `process_rgba` + `encode_variants_from_rgb16*` (with progressive support) now fuse the tone/convert + alpha write; pure-encode Tauri callers (ingest/export) never allocate/retain a 3ch RGB8 intermediate. See crates/raw-pipeline/src/casabio_encode.rs and docs/suggested-settings.md "Native / Tauri Preferences". (Work started on tauriparity branch.)
  - Harness extended (src/bin/raw_decode_bench.rs) with GOB/P2200 ref scanning + direct path always used for reported encode; sample release direct-rgba ~322 ms on 20 MP Gobabeb ORF.
- [ ] **Decode (Region/ROI):** Default to JXTC/tiled ROI when available for crops/thumbs. Pass the normalized subject rect down to the decoder instead of full-decode-then-crop.
  - (Harness ready with metric plumbing + scan + pre-crop simulation (0.5-2.1 ms @128/256 px on P2200 refs, beating WASM JXTC 9-15 ms); low-level decode paths on small assets wired 2026-06-04 (bench). **2026-06 continuation: extracted to shared `crates/raw-pipeline::jxl_lowlevel` (opt-in feature "jxl-lowlevel", thin pub fns decode_full + decode_progressive_first_total + compat aliases). Bench + Tauri will share identical FFI state machine. Real Tauri codec + sidecar emit / JXTC or SetCrop native-crop pending (src-tauri not in this workspace). See outputs/tauri/* + HANDOFF continuation.**
- [x] **Decode (Full Loads):** Progressive decode delivering DC/early passes directly to Tauri textures (no worker hop).
  - Truly-progressive proof landed for WASM path 2026-06-03 — see docs/superpowers/specs/2026-06-03-truly-progressive-jxl-design.md and docs/Benchmark results/truly-progressive-2026-06-03.md. SNEYERS_PRESET wired in facade.ts (USE_SNEYERS_DEFAULT=true); firstPaint < 1% bytes, ≥17 paints on reference binary. Tauri native port: pending separate handoff. **Shared low-level prog decoder model now in jxl_lowlevel (2026-06).**
- [ ] **Shared Metrics:** Implement equivalent `onMetric` hooks in Tauri for apples-to-apples comparisons with WASM.
  - (Bench now emits the canonical names decode_buffer_extract_ms (0), decode_region_downsample_ms, source_pixels_decoded + summary/JSON + time_to_first from lowlevel prog; ready for Tauri surface to match. 2026-06-04 run on supplied timings updated audit/suggested/outputs. **Canonical impl + metric surface point is now the jxl_lowlevel module.**)

## Boundary Cost Audit Phase 2 (`docs/boundary-cost-audit.md`)
- [x] **Deepen RAW → JXL Implementation:** `take_rgba()` (Phase 2A) implemented + measured (30-file Gobabeb: JS path wins, +10-13 ms WASM prep, ~4-5% regression). Phase 2B deprioritized. Decision recorded in `docs/boundary-cost-audit.md` §12.2 and `docs/suggested-settings.md`.
- [x] **Strengthen Audit Document:** Sections 12–15 now cover: RAW boundary (30-file), decode pixel handoff (11-file crop bench), native parity (§13.1), progressive encode boundary (§14), Tier 1 decision + remaining unquantified costs (§15). Done.
- [x] **Next Targets:** Decided in §15: JXTC ingest at ingest-time for subject-crop assets is Tier 1 (10-30x crop win). Animation marshaling and `toArrayBuffer` slice are lower-priority deferred items. See `docs/boundary-cost-audit.md` §15.

## Grand Unification Roadmap (`docs/ai-unification/unification-roadmap.md`)
- [ ] **Tier 1 Migrations:** Canonicalize `check-work`, `owl`, and Epic review skills.
- [ ] **P0-4 Enforcement:** Mandate "code-review-graph" usage in `AGENTS.md` and core review skills.
- [ ] **Projector Hardening:** Improve Grok projector and build Claude projector.
- [ ] **Dogfood Loop:** Continue migrating skills (1 new canonical skill per session).
- [ ] **Future Tiers:** Migrate `pptx`, `docx`, `xlsx`, `frontend-design`, and `find-skills`.