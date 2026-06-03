# Incomplete Plans & Outstanding Action Items

This document consolidates the remaining tasks, goals, and follow-ups from various handoff and plan documents across the repository.

## Environment & Build Issues (`issues.md`)
- [ ] **Rebuild WASM Artifacts:** Fix Docker API connection issue and run `npm --workspace packages/jxl-wasm run build`.
- [ ] **Rebuild Native Addon:** Fix missing `node-gyp` module issue and run `npm --workspace packages/jxl-native run build`.
- [ ] **Fix Full Facade Test Failure:** Resolve the tier-detection expectation (`detectTier` returning `simd-mt` instead of `scalar`).
- [ ] **Fix Wrapper Lab Test Failure:** Address the pre-existing test/page mismatch in `web/jxl-wrapper-lab.test.js`.

## P3 Lightbox JXL Decoder (`docs/handoff-p3-lightbox-jxl-decoder.md`)
- [ ] **P3.2 — Viewport / ROI Awareness:** On zoom/pan changes, compute visible region and pass `region` to the decoder. Re-decode the new visible region when the user pans/zooms significantly.
- [ ] **P3.3 — JXL Container Previews + JXTC + Polish:** Extract and use embedded preview/DC before full decode. Prefer JXTC decode path for ROI. Wire multi-frame progressive navigation for animated JXLs. Expose a "JXL decode strategy" badge.

## P3.1 Lightbox Progressive Decoder (`docs/superpowers/handoffs/2026-06-p3.1-remaining-tasks-5-6-7.md`)
- [ ] **Task 5 (Update Call Sites):** Update call sites (`drawLightboxForCard`, `prefetchJxl`, `decodeFullJxlFor`, `repaintThumbFromJxl`) with correct cache policies (`onFirstProgress`, `onFinal`, `never`).
- [ ] **Task 6 (Verification):** Verify progressive first paint, `'onFirstProgress'` slider behavior, `'onFinal'` prefetch behavior, jsquash fallback, and no regressions in live editing/source cycling.
- [ ] **Task 7 (Polish):** Clean up leftover TODOs, verify prominent NOTE comments, update `lightbox-impl-decisions.md`.

## Tauri Optimization: Predator Mode (`docs/HANDOFF-tauri-predator-mode.md`)
- [ ] **Image Pipeline Hot Paths:** Hunt for inefficiencies in thumbnail/lightbox generation paths. Optimize downscaling, unsharp masking, and tone mapping with manual loops and integer paths.
- [ ] **Boundary Cost Audit (Desktop):** Trace data flows to eliminate unnecessary buffer copies/handoffs. Focus on priority semaphores, gallery rendering, OPFS-like caches, and IPC command boundaries.

## Progressive Encode & Decode Predator Mode (`docs/HANDOFF-predator-progressive-2026.md`)
- [x] **Measurement & A/B Testing (ref run + numbers):** 2026-06-03 predator-progressive-metrics run on small_file.jpg (300×225 q85) captured 18-cell Dc×group×effort data (encodeMs, size, progressEvents=2 always, first* bytes/ms). Numbers + analysis fed to HANDOFF continuation, suggested-settings.md, boundary-cost-audit.md, and reference-small-matrix-report.md (new section). Decode collection now also wired in correlation matrix worker (so page sweeps produce the layer metrics). Full visual A/B ("first recognizable" spatial quality on paint page for g=0 vs 1) + larger refs (Gobabeb) + prefix-probe for true early bytes remain.
  - See `docs/HANDOFF-predator-continuation-2026-06-encode-matrix.md` (the measurement run results block + remaining next steps: visual confirmation in paint page, Tauri equivalent, report updates — some docs now done).
- [ ] **Tauri Parity:** Wire the new `encode_variants_with_progressive` to provide progressive output for the desktop gallery/lightbox. (encode_variants_with_progressive with dc/group already present in crates/raw-pipeline/src/casabio_encode.rs; sibling Tauri app + matrix bench integration pending.)
- [ ] **Test/Heuristics Polish:** Add per-pass bytes/quality logging/CSV export in the paint tool. (Partially addressed by paint exports + byte-benchmark + now matrix CSV carrying the Dc/group columns. Prefix-probe enhancement identified as headroom in the 2026-06 ref run for better "min bytes to first progress".)

## Tauri / WASM Parity (`docs/HANDOFF-tauri-parity-2026-06-03.md` — active on tauriparity branch; see also archived `docs/Completed plans/Archived_HANDOFF-tauri-wasm-parity-2026.md`)
- [x] **Encode (RAW → JXL):** Implement a direct-RGBA production path inside `crates/raw-pipeline` (bypassing intermediate RGB arrays). `process_rgba` + `encode_variants_from_rgb16*` (with progressive support) now fuse the tone/convert + alpha write; pure-encode Tauri callers (ingest/export) never allocate/retain a 3ch RGB8 intermediate. See crates/raw-pipeline/src/casabio_encode.rs and docs/suggested-settings.md "Native / Tauri Preferences". (Work started on tauriparity branch.)
  - Harness extended (src/bin/raw_decode_bench.rs) with GOB/P2200 ref scanning + direct path always used for reported encode; sample release direct-rgba ~322 ms on 20 MP Gobabeb ORF.
- [ ] **Decode (Region/ROI):** Default to JXTC/tiled ROI when available for crops/thumbs. Pass the normalized subject rect down to the decoder instead of full-decode-then-crop.
  - (Harness ready with metric plumbing + scan + pre-crop simulation (0.5-2.1 ms @128/256 px on P2200 refs, beating WASM JXTC 9-15 ms); low-level decode paths on small assets wired 2026-06-04 (bench). Real Tauri codec + sidecar emit / JXTC or SetCrop native-crop pending (src-tauri not in this workspace). See outputs/tauri/*-2026-06-04.md + HANDOFF continuation.)
- [x] **Decode (Full Loads):** Progressive decode delivering DC/early passes directly to Tauri textures (no worker hop).
  - Truly-progressive proof landed for WASM path 2026-06-03 — see docs/superpowers/specs/2026-06-03-truly-progressive-jxl-design.md and docs/Benchmark results/truly-progressive-2026-06-03.md. SNEYERS_PRESET wired in facade.ts (USE_SNEYERS_DEFAULT=true); firstPaint < 1% bytes, ≥17 paints on reference binary. Tauri native port: pending separate handoff.
- [ ] **Shared Metrics:** Implement equivalent `onMetric` hooks in Tauri for apples-to-apples comparisons with WASM.
  - (Bench now emits the canonical names decode_buffer_extract_ms (0), decode_region_downsample_ms, source_pixels_decoded + summary/JSON + time_to_first from lowlevel prog; ready for Tauri surface to match. 2026-06-04 run on supplied timings updated audit/suggested/outputs.)

## Boundary Cost Audit Phase 2 (`docs/HANDOFF-boundary-cost-audit-2026.md`)
- [ ] **Deepen RAW → JXL Implementation:** Consider producing RGBA8 directly inside tone/convert stage instead of post-hoc conversion. Update benchmarks and add traces.
- [ ] **Strengthen Audit Document:** Add precise before/after cost estimates. Flesh out decode pixel handoff, animation marshaling, and worker transfers.
- [ ] **Next Targets:** Decide on the next Tier 1 opportunity (e.g., keeping decoded pixels in WASM longer, progressive output ownership).

## Grand Unification Roadmap (`docs/ai-unification/unification-roadmap.md`)
- [ ] **Tier 1 Migrations:** Canonicalize `check-work`, `owl`, and Epic review skills.
- [ ] **P0-4 Enforcement:** Mandate "code-review-graph" usage in `AGENTS.md` and core review skills.
- [ ] **Projector Hardening:** Improve Grok projector and build Claude projector.
- [ ] **Dogfood Loop:** Continue migrating skills (1 new canonical skill per session).
- [ ] **Future Tiers:** Migrate `pptx`, `docx`, `xlsx`, `frontend-design`, and `find-skills`.