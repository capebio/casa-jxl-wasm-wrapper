# EpicCodeReview 20260619T194416Z

## Target

`src/lib.rs`, `packages/jxl-wasm/src/facade.ts`, `crates/jxl-ffi/build.rs`, `external/libjxl`

---

## Section 000 — src/lib.rs + packages/jxl-wasm/src/facade.ts (COMMITTED 960f0692 + 8de70845)

20 fixes applied and committed. 10 perf-sensitive tasks deferred (no harness path; see QUESTIONS.md).

**src/lib.rs — correctness:**
1. **CR2 Bayer phase retry missing RGGB (0,0)** — `ALT_PHASES` now covers all 4 Bayer origins; RGGB cameras no longer fail phase recovery.
2. **PerceptualComparer::new length validation** — `assert!` on `ref_rgba.len() == width*height*4`; surfaces `JsError` on mismatch.
3. **DNG/CR2 rational absent-field denominator** — absent `exposure_time`/`fnumber`/`focal_length` use `den=0` (same as ORF); JS callers no longer see `"0 sec"` / `"f/0"`.
4. **`fs_to_js` lumaVariance divisor** — divides by 65025 (255²), not 65536; matches `frame_stats.rs` native path.

**src/lib.rs — structure:**
5. **`process_orf` flag docs** — `OUT_FULL_16=8` and `OUT_NO_ORIENT=16` (with collision-history note) added to WASM API doc comment.
6. **`ProcessResult.wb_mode` sentinel** — 0xFFFF sentinel documented as `///` JSDoc on the field.
7. **`impl From<Cr2Decoded> for DngDecoded`** — replaces field-by-field struct copy in `process_cr2_impl`; compiler now enforces field completeness.

**packages/jxl-wasm/src/facade.ts — correctness:**
8. **Metadata pointer OOM** — OOM during ICC/EXIF/XMP malloc now throws instead of silently dropping user-provided metadata.
9. **`prepareAdvancedSettings` OOM** — OOM now throws instead of silently returning `count=0`.
10. **`_a6Checked` reset on reload** — flag reset in `setForcedTier` and `setJxlModuleFactoryForTesting`; prevents stale pointer-size assertion on module hot-reload.
11. **`perceptualConstancyApplyBulk` fallback** — scalar no-op now emits `console.warn`; was silently identity-mapping.
12. **`pendingPushError` propagation** — error from failed push now re-thrown in `cancel()`.

**packages/jxl-wasm/src/facade.ts — structure/API:**
13. **`setForcedTier` clears `_cachedDetectedTier`** — stale auto-detected tier no longer persists after forced-tier override.
14. **`JxlCapabilities` and `getCapabilities` exported** — callers can now introspect bridge capability without accessing internals.
15. **Console.log removed from tile decode hot path** — `decodeTiledRegionRgba8` and `decodeTileContainerRegion` no longer emit per-call logs; data available via `onMetric`.
16. **Console.log removed from `LibjxlEncoder`** — two unconditional per-encode logs removed (profile summary + module-setup timing).
17. **`deferredRelease` buffer sized dynamically** — was fixed at 1920×1080×4 (throws on 4K+); now grows lazily to `pixData.byteLength` on first use or when frame exceeds capacity.

**Deferred — perf-unverified (10 tasks):**
Hacker tasks for `fs_core_simd` SIMD re-read, `fs_core_simd_exact` FNV loop, `downscale_rgb16_planar` SIMD, `downscale_rgba` SIMD, `decode_orf_raw` double-demosaic gate, `bilinearResize` rgba16 weight hoisting, `eventsProgressive` copy elimination, `eventsOneShot` streaming, `readBufferView` view promotion, DNG lb/thumb downscale restructure — all deferred; no flipflop/bench path for these kernels in-session. See QUESTIONS.md.

---

## Section 001 — crates/jxl-ffi/build.rs

**No fixes applied.** The plan task list was empty for this section. The file is clean at HEAD (commit `988f8b94`). No staged changes; no commit needed.

The file is well-structured: wasm32 short-circuit, cmake-rs build with correct Windows ClangCL + `/O2 /Ob2` release flags, lib/lib64 fallback, static link lines for all seven libjxl archives, OS-conditional C++ stdlib linking, and bindgen with `allowlist_*` + `NewType` enum style. One finding was deferred to the global pass as an ADR draft (see Global Pass below).

---

## Section 002 — external/libjxl (build-unverified C++)

All findings deferred to QUESTIONS.md — cannot verify without a cmake rebuild.

Findings deferred (recorded in QUESTIONS.md under the session's ADR draft block):

- **Stale bindgen tracking** — `build.rs` emits `rerun-if-changed=wrapper.h` but not for individual `include/jxl/*.h` headers; a header-only libjxl upgrade will produce stale bindings silently. ADR draft: `.epiccodereview/20260619T194416Z/global/adr_draft/bindgen-rerun-tracking.md`.
- **jxl-ffi runtime version assertion** — no startup check that the compiled-in libjxl major.minor matches the linked binary. ADR draft: `.epiccodereview/20260619T195435Z/global/adr_draft/jxl-ffi-runtime-version-check.md`.
- All C++ source findings in `external/libjxl` itself require a cmake rebuild under Emscripten or MSVC to verify; deferred to owner review.

---

## Global Pass

ADR drafts produced (all recorded in QUESTIONS.md, files in `.epiccodereview/20260619T194416Z/global/adr_draft/`):

1. `memory-budget-policy.md` — define a typed memory budget policy for the RAW→JXL pipeline
2. `unified-butteraugli-interface.md` — unify the ButteraugliComparator vs ButteraugliInterface call sites
3. `dng-cr2-lookrenderer-factory.md` — extract a LookRenderer factory to avoid per-call reconfiguration
4. `processresult-lazy-buffers.md` — lazy-allocate ProcessResult pixel buffers (skip alloc when caller only wants metadata)
5. `dng-cr2-planar-downscale.md` — pre-demosaic planar downscale for preview-only DNG/CR2 (10–20× throughput gain for gallery ingest)
6. `ar-thumb-first-preview.md` — `process_orf_thumb_fast()` 2×2 bayer-quad average for sub-30ms AR thumbnails
7. `processresult-metadata-only.md` — `parse_dng_metadata()` / `parse_cr2_metadata()` WASM exports for header-only metadata scans
8. `bindgen-rerun-tracking.md` — emit `rerun-if-changed` per libjxl header to prevent stale bindings

Section 000 ADR drafts (`.epiccodereview/20260619T194416Z/sections/000/adr_draft/`):

9. `simd-downscale-rgb16-planar.md` — wasm32 SIMD fast path for `downscale_rgb16_planar` (4–8× throughput; pixel-identical)
10. `simd-downscale-rgba.md` — wasm32 SIMD fast path for `downscale_rgba` using `v128` 4-pixel loads (4× wider; pixel-identical)
11. `look-renderer-tests.md` — unit tests for LookRenderer clarity-clone guard, black pedestal subtraction, orientation dim invariant, and demosaic_rggb_shuffle_simd parity

---

## Open Questions

See `QUESTIONS.md` for the full deferred backlog. Key items from this session:

- All `external/libjxl` C++ source findings require cmake verification before action.
- ADR drafts 1–11 above are awaiting ratification before implementation.
- `perceptual-comparer-validation.md` (section 000 ADR) was partially addressed by fix #2 above; the remaining method-level guards are still open.

Reference: `QUESTIONS.md` lines ~990–1107 (session 20260619T194416Z ADR block).
