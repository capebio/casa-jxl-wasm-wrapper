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
- [ ] **Measurement & A/B Testing:** Run A/B testing on real images via served pages to find "bytes to recognizable". Serve web pages and compare early passes.
  - See fresh continuation: `docs/HANDOFF-predator-continuation-2026-06-encode-matrix.md` (correlation matrix now has progressiveDc + groupOrder as first-class sweep factors + bias; decode-side layer metrics (numEvents, firstProgress* from feeding chunks to progressive decoder) landed in worker + live table/CSV/summaries heatmaps. Next: real ref runs on the matrix + capture "bytes to first" numbers + data back into docs).
- [ ] **Tauri Parity:** Wire the new `encode_variants_with_progressive` to provide progressive output for the desktop gallery/lightbox.
- [ ] **Test/Heuristics Polish:** Add per-pass bytes/quality logging/CSV export in the paint tool. (Partially addressed by paint exports + byte-benchmark + now matrix CSV carrying the Dc/group columns.)

## Tauri / WASM Parity (`docs/HANDOFF-tauri-parity-2026-06-03.md` — active on tauriparity branch; see also archived `docs/Completed plans/Archived_HANDOFF-tauri-wasm-parity-2026.md`)
- [x] **Encode (RAW → JXL):** Implement a direct-RGBA production path inside `crates/raw-pipeline` (bypassing intermediate RGB arrays). `process_rgba` + `encode_variants_from_rgb16*` (with progressive support) now fuse the tone/convert + alpha write; pure-encode Tauri callers (ingest/export) never allocate/retain a 3ch RGB8 intermediate. See crates/raw-pipeline/src/casabio_encode.rs and docs/suggested-settings.md "Native / Tauri Preferences". (Work started on tauriparity branch.)
- [ ] **Decode (Region/ROI):** Default to JXTC/tiled ROI when available for crops/thumbs. Pass the normalized subject rect down to the decoder instead of full-decode-then-crop.
- [ ] **Decode (Full Loads):** Use progressive decode to deliver DC/early passes to Tauri textures immediately without JS worker boundary overhead.
- [ ] **Shared Metrics:** Implement equivalent `onMetric` hooks in Tauri for apples-to-apples comparisons with WASM.

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