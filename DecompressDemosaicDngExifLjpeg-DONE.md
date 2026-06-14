# Raw Pipeline Native Decode Review: Decompress Demosaic Dng Exif Ljpeg

**Scope:** ONLY crates/raw-pipeline/src/decompress.rs, demosaic.rs, dng.rs, exif.rs, ljpeg.rs. All analysis, issues, proposed fixes from 21 lenses performed exclusively against these. No other files read or referenced for changes.

**Process:** 21 lenses applied (strategic links, API, stages, state, data structs, hot kernels, boundaries, support, Owl multi-perspective, reverse film, astronomical analogies, LLM/ML facilitation, gaming principles, photogrammetry/digital twins, Butteraugli interaction, AR/immersive plant recognition, advanced non-Riemannian perceptual color model integration points, gap identification x2, pointer/move tricks, bird's-eye connectivity). Duplicates amalgamated. Token use minimized: full parallel read of 5, targeted pattern greps on individual files only, then this synthesis. Issues limited to verifiable from content. Fixes include suggested snippets where ambiguous.

**Document structure:** Chapters as implementation layers (group related concerns for one skilled implementer). Handoffs target one primary file per agent (5+ sessions possible). Each contribution block starts with exact required phrase. At end of this doc: instruction for last agent.

## Chapter 1: Bitstream & Predictive Decode Layer (decompress + ljpeg linkage)
Focus: two independent entropy decoders feeding bayer u16. Link: no direct calls, but both produce row-major u16 mosaics for demosaic; dng orchestrates ljpeg. Data passed: &[u8] compressed -> Vec<u16>/&mut [u16] bayer (or strided). decompress (Olympus 12b predictive + carry + 3-bit low) is ORF-only; ljpeg (LJPEG SOF3 pred=1 + DHT) is DNG tile-only.

**Amalgamated issues/fixes (efficiency/speed/perf/bugs/features):**

- Two similar but distinct BitReader impls (decompress batch-fill 56 + leading_zeros nbits + no-FF; ljpeg 48-fill + explicit FF00 stuffing + peek/consume/get_bits split + real_in_buf tracking). Dupe code, divergent truncation semantics. Long-term maintenance and WASM perf risk.
- Olympus: static OnceLock huff (good). Ljpeg: thread_local RefCell<Vec<(key, Rc<HuffTable>)>> FIFO cap 8 (L11 cache) + right-sized 1<<max_bits lookup (L10, good).
- Hot path: per-pixel bit ops + predictor. decompress uses delay-line west/north_west (D1: "move pointer" equiv, avoids re-reads — already 300ms->0ms class win). ljpeg: left[] + prev_row_first[] for pred=1.
- Truncation: explicit Err everywhere post-D4; good. Tests cover.
- Gaps: no shared BitReader trait/util; no cps=1 fastpath in ljpeg decode (inner comp loop always); ljpeg only predictor=1 (bail others; comment L12 says acceptable).
- From Owl/reverse: bit readers are "photon counters" — truncation as "underexposure". Backwards: from decoded values one can simulate bitstreams for test gen.
- Gaming/AR/ML: cache is texture-like reuse; probe_tile is "occlusion query" / quicklook for scheduling (used in dng parallel tiles). Half and bands later help latency.
- Color/Butteraugli/photogram: accurate early linear from these is prerequisite for any downstream perceptual model or metric (bad decode -> butteraugli wastes time on artifacts). Provide clean counts + precise meta.

**Proposed (amalgamated, per-file):**

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

For decompress.rs (agent primary file: decompress):
- Minor: expose or document a "linearize" post step? (black not here; see dng). No change needed if callers handle.
- Perf (small): in fill, the while pad loop is rare; keep. D3/D6 already rejected in tests (bench notes) — do not reintroduce MaybeUninit or single-fill without new evidence.
- Feature (long-term): nothing format-specific beyond current; keep bit-exact port.

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

For ljpeg.rs (primary):
- Unify with decompress BitReader? Extract common? (but stuffing differs: olympus never stuffs; ljpeg does). Cost: complexity. Benefit: one truncation model. Proposed sketch (only if perf win measured; WASM target):
  ```
  // In shared module (but stay in file for now): 
  // trait or conditional compile for stuffing. Keep separate for clarity unless >5% win.
  ```
  Prefer: add `#[inline(always)]` on peek/consume hot; specialize decode for cps==1 (CFA DNG common) to elide comp loop and array.
  ```
  if cps == 1 {
      // fast 1-comp path using left[0], no array
  } else { general }
  ```
- Cache: current FIFO 8 + exact payload key (bits+values) good. Increase to 16? Only with evidence (tiles per DNG often repeat DHT).
- Predictor: keep bail on !=1. If needed later, add behind flag + tests. For now correct per spec+comment.
- Probe: already cheap (stops at SOF). Good for dng parallel planning.
- Truncation/err: already strict + tests (l15 series). Add one for max_bits==0 after DHT parse? Covered indirectly.

## Chapter 2: Demosaic & Transform Layer (demosaic primary, consumed by dng)
Focus: bayer u16 (RGGB default, phased general) -> rgb u16 (interleaved). Bilin fast, MHC gradient-corrected quality (~2x), half (1/4, 10x fast, LOD/ML), band (halo  for strip fusion, X2 memory win), saliency (lap on MHC correction per 32x32), mhc_matrix (Q12 fused 3x3 at demosaic time). Parallel rayon rows/bands.

**Amalgamated issues (from all lenses):**

- Massive duplication: mhc_pixel logic literally copied 5-6x (mhc_pixel, mhc_pixel_phased, band variants, mhc_pixel_lap for saliency, matrix variant, rggb_mhc_band duplicate). ~200+ lines of near-identical 4-arm match + at() + >>3/>>2 + clamp. Bug risk, blocks lens17 advanced color (per-pixel math must be single source). Also bayer_pixel vs unrolled.
- at(): debug_assert + unchecked — correct + fast. clamp helper.
- Unroll: excellent in rggb (2-col, row_par hoist, slice north/here/south, while col+1). mhc_rggb has similar but more complex n2/s2. Small-width fallbacks scalar via helper.
- Saliency: uses lap = |4c - n2..| at R/B sites (0 at G). Parallel bands own grid rows (no atomics). Grid returned with rgb. SALIENCY_BLOCK=32.
- half: simple 2x2 mean G; no interp. Artefact-free claim for pyramid/AR.
- validate: checks dim, len. Errors use "×" char? No, ascii in some paths.
- Perf: vec![0; full*3] always. Band versions take &mut out. parallel feature.
- Hot: per-pixel ~10-20 at()/adds/muls. LLVM benefits from slices + known width.
- Bugs: in some band paths global_row0 param unused (comment says parity not needed). mhc clamps after >> .
- State: pure. No queues.
- Boundaries: input &[u16] bayer (from decompress/ljpeg), output Vec or &mut. No WASM direct.
- Support: tests sparse in this file (most in consumers); golden not here.
- Owl/gaps: duplication is largest unlit house section (the "MHC math maintenance wing"). Reverse film: to support "raw ML" one could add inverse sample (pick known phase positions from rgb estimate).
- Gaming/AR/LLM/photogram: half + saliency = perfect for real-time plant ID (thumbnail inference + attention ROI). Band fusion enables mobile/low-mem AR without full frame. Linear output + phase meta feeds photogram calibration and LLM raw-aware models. For advanced color (lens17): the mhc_matrix is existing hook for sensor-sharpen B or log-space approx, but since per-pixel apply_tone is later, here just ensure linear fidelity and matrix path works. Saliency lap already computes local activity — could feed adaptive perceptual (butteraugli hint) but keep internal for now.
- Tricks: slice hoisting = "move pointer" over rebase calc. Unroll = game inner loop. Pointer delay lines in upstream but similar spirit here (neighbor pre-resolve).
- Birdseye: this is the convergence point. All visionary apps route through quality/cost controls here.

**Proposed (consolidated):**

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

For demosaic.rs (primary agent file):
1. Factor MHC math to single source. Introduce private helper or (for perf) macro that all paths call. Keep hot unrolled rggb_mhc body but extract the 4 cases. Example skeleton (paste into file, replace bodies):
   ```
   #[inline(always)]
   fn mhc_core(raw: &[u16], w: usize, r_c: usize, r_n: usize, r_s: usize, r_n2: usize, r_s2: usize,
               col: usize, c_w: usize, c_e: usize, c_w2: usize, c_e2: usize, phase: (usize,usize))
       -> (i32, i32, i32) {
       let pr = (r_c + phase.0) & 1; let pc = (col + phase.1) & 1;
       match (pr, pc) { ... exact 4 arms from mhc_pixel_phased ... }
   }
   // Then phased/band/saliency call mhc_core(..., phase). For rggb_mhc (phase=0,0) use specialized or same.
   // For lap variant: return 4-tuple with lap computed only on R/B arms.
   ```
   Update all  mhc_* and band and with_saliency and matrix to delegate. This is prerequisite for any future per-pixel LUT or advanced transform without 5-way bug surface. Cost: one call; benefit: maintainability + future color science.
2. Add black-level aware path? Or post helper? Within scope: add `apply_black_white(bayer: &mut [u16], black: u16, white: u16, scale_to: Option<u16>)` or similar that does `(v.saturating_sub(black) * scale) >> shift` clamped. Expose for dng callers who currently carry black separate. (Facilitates photogram/AR/color constancy by giving normalized linear early.)
   ```
   pub fn normalize_black_white(raw: &mut [u16], black: u16, white: u16) {
       // or return new vec; but &mut to allow reuse
       for v in raw.iter_mut() {
           let s = (*v as i32 - black as i32).max(0) as u16;
           *v = s; // or full scale if wanted
       }
   }
   ```
   Callers (dng) decide when. Add unit test sweep.
3. For half + saliency: keep. Perhaps a combined half_with_saliency if needed later (not now).
4. Small: in rggb_mhc_band the global_row0 is dead in scalar (parity comment) — remove param or use if future vectorized needs row phase.
5. No new unsafe beyond existing at(). No MaybeUninit (policy per comments elsewhere).
6. Expose cfa phase helpers if not (already some in dng).

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

(Secondary cross in dng later.)

## Chapter 3: DNG Container, Metadata & Orchestration Layer (dng primary)
Focus: TIFF/IFD walk (visited, depth64, NewSubFileType, largest area wins), RawIfd collection, tag parse (black/white, CFA, matrices, as_shot, iso, make/model/orient), ljpeg tile probe+decode parallel (X1 full per-tile), uncompressed strips/tiles (endian), WB neutral -> r/g/b scaling, choose_camera_to_srgb (forward preferred or invert color + XYZD50->sRGB), align_to_rggb + cfa_phase, two output paths: DngImage (bayer raw) and fused decode_bytes_demosaiced (rgb post-mhc, black/white carried, decode_ms/demosaic_ms, strip fusion for RGGB).

**Amalgamated issues/fixes:**

- IFD walk: solid (HashSet prevent cycles, subs recursive). raw_ifd_supported_candidate filters subsampled + has storage + full res. Largest-area heuristic for raw.
- Parallel tiles (decode_one per idx -> DecodedTile {buf compact, active rect}): collect then serial blit loops. Good (avoids shared &mut contention). Uses probe + decode_tile_compact.
- Uncompressed: byte by byte u16 with endian per tile/strip; pad skip for edge tiles.
- Color: mul3x3, invert3x3 (det check), choose... . XYZ const. read_matrix handles 5/10/11. Tests for srational + prefer forward.
- Fused (decode_bytes_demosaiced): re-walks (dupe code with decode_bytes), then for RGGB uses band? (code cuts off in read but comment describes halo carry + demosaic_rggb_mhc_band or fallback full). Timings recorded. Peak mem note: ~RGB +1 tile row +2 halo.
- Meta: Exif-like but DNG specific + matrices + iso. orientation raw.
- Link to demosaic: uses for post or fused; cfa_phase, align.
- Link to ljpeg: direct.
- Bugs: in provided read, fused fn cuts at color_matrix=; assume completion mirrors decode_bytes + conditional band for rggb. Some dead `_cps`, `_ = has_tiles`.
- Perf: rayon on tiles (good for many small); blit serial cheap. vec per tile.
- State: WalkState + visited during parse. No runtime session state.
- Gaps: only DNG (no other raws); limited compression; no application of orientation to pixels; no black subtraction here (carried).
- Owl/LLM/AR/photogram/gaming: matrices + neutral + black/white + GPS? (no, but make/model/orient/iso/focal implicit via exif sibling) = gold for calibration in digital twin, AR scale/pose, LLM conditioning, color constancy (lens17). Fused band path = "streaming level" for real-time. Parallel tiles like GPU dispatch.
- Reverse: from DngDemosaiced rgb + matrix one could back-project for verification.
- Tricks: compact per-task buf + blit = move data not pointer-in-place but close; probe separate = cheap plan phase.
- Birdseye connectivity: dng is the "telescope control" that points ljpeg probe/decode and demosaic band at the data, bundles meta for all downstream.

**Proposed (primary dng):**

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

For dng.rs (primary):
1. Dedup walk/parse + meta extraction between decode_bytes and decode_bytes_demosaiced. Extract `fn parse_dng(data: &[u8]) -> Result<(WalkState, RawIfd, bool /*le*/)>` or similar. Both paths call once.
2. In fused path (complete the cut-off code if needed): ensure RGGB uses demosaic_rggb_mhc_band with proper halo (2 rows typical for MHC n2). Carry bottom rows of prior band as top halo for next (comment describes). For non-RGGB fallback full mosaic + demosaic_bayer_mhc (rarer).
   Snippet for band orchestration (if not present):
   ```
   // After ljpeg per-tile or strip decode to temp mosaic band...
   // For simplicity current fused may alloc full bayer then demosaic; to hit X2:
   let halo = 2;
   let band_h = /* tile row or chosen strip */;
   let mut ctx = vec![0u16; (band_h + 2*halo) * width]; // or ring
   // fill ctx with halo replicate or carry, decode into middle, call demosaic_rggb_mhc_band(ctx, ..., halo, first_local, num, &mut rgb_out)
   // drop bayer band after.
   ```
3. Add optional black subtraction + scale in the output paths (or new `decode_bytes_demosaiced_normalized`). Use or call proposed normalize from demosaic. Update Dng* structs if needed (or document "raw values have black bias; subtract before use").
4. Blit optimization: when active_w == buf_w use copy_from_slice for rows:
   ```
   let dst = &mut out[dst_base .. dst_base + aw];
   let src = &td.buf[src_base .. src_base + aw];
   dst.copy_from_slice(src);
   ```
5. Expose more for color science: ensure color_matrix always camera->sRGB via the path; add comment hook for future B sharpen or log pre-matrix (but impl in LookRenderer).
6. Tests: already good (uncomp endian, matrix, cfa, candidate). Add one for fused mem note? Or black carry.

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

## Chapter 4: Metadata Mapping Layer (exif primary)
Focus: thin adapter `ExifData::from_orf_info(info: &OrfInfo, image_w, image_h) -> Self`. Maps all fields, Option handling, ratio conversion (skip zero den), gps struct, wb_from_camera flag, raw vs display dims.

**Issues (few, focused):**

- Pure, correct, serializable (serde). Tests exhaustive for present/absent/zero-den/signed.
- No hot code, no alloc beyond Strings.
- Link: ORF side only (decompress produces the image dims passed in). DNG has parallel meta in WalkState/DngImage (no shared ExifData).
- Gaps: no DNG exif equivalent here (dng produces its own fields). Orientation etc duplicated concepts.
- For AR/photogram/LLM: provides lens, gps, focal_35, wb, datetime, quality — perfect context tokens or geotag for recognition / twin alignment.
- Owl: "unlit" is lack of unified metadata struct across ORF/DNG. But since exif.rs is mapping only, the unification would be higher (out scope). Within: perhaps add `impl From<DngImage> or similar` but would require changing dng output — keep separate unless asked.
- No bugs apparent. Trivial "speed": none.

**Proposed:**

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

For exif.rs (primary, small surface):
- None mandatory. Optional polish (if fits "positive"): add `impl Default for ExifData { orientation:1, .. }` or helper to merge DNG-ish meta into ExifData for callers wanting single type (but since no Dng dep allowed without scope change, add only free fn or comment). Prefer: add unit test for roundtrip serde if not. Keep minimal — current is clean.
- To support color constancy/LLM: ensure wb_mode etc carried (already are).
- If later unified meta wanted, this file would be the place for From impls.

## Chapter 5: Cross-Cutting, Support & Vision Integration Layer
(Spans all 5 files lightly; implementer may touch 1-2 related for cohesion. One "last agent" session.)

Amalgamated cross issues:
- Error style: raw-pipeline uses String; dng/ljpeg use anyhow. Inconsistent at boundary.
- Alloc pattern: always full upfront Vec in top APIs. into/band/compact/probe mitigate for callers.
- Dupe: mhc_pixel xN (demosaic ch2); meta walk vs exif (ch3/4); BitReader x2 (ch1).
- No progress hooks, no logging — correct for lib.
- Tests: good coverage of kernels, errors, ports (golden in decompress, minimal in ljpeg, matrix/uncomp in dng). No integration test in these files (would require other modules).
- From all visionary lenses: these 5 files are the "sensor front end". Implementing the proposals yields trustworthy, low-mem, multi-quality linear data + calibration bundle that directly accelerates:
  - Photogram/digital twins (accurate radiometry + pose meta)
  - LLM/ML recognition (half + saliency + linear + rich exif for fast/accurate inference)
  - AR real-time plant (band streaming + LOD + phase for on-device)
  - Advanced color (clean input to LookRenderer non-Riemannian engine; existing matrix fusion point)
  - Butteraugli/encode (fewer artifacts upstream = faster/better perceptual metric + JXL)
  - Gaming-like perf (parallel, cache, LOD, unroll already strong; factor for longevity)
- Largest gaps illuminated by lenses: (1) format breadth (only Olympus+DNG subset), (2) full streaming/incremental row API (bands exist but top-level full), (3) explicit vectorization + black normalization as first-class. Dupe math is the immediate technical debt blocking long-term color/AR work.
- Last bird's eye: the files form a coherent "acquisition telescope" — bit-accurate front optics (decompress/ljpeg), transform corrector (demosaic with saliency focus), mount/metadata (dng/exif), with multiple eyepieces (full/mhc/half/band). Connectivity via simple Vec slices + small phase/black/wb/matrix descriptors is strength (easy to insert future stages).

**Cross proposals (assign to last agent or primary file owners as fits):**

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Cross (touch demosaic + dng primarily; or last session):
- Unify error? Keep as-is (anyhow in container good for context).
- Add to demosaic (or new module but stay in one file): the normalize helper above.
- In dng decode paths: after bayer decode (pre or post demosaic) optionally call normalize if black >0. Record in output struct "black_subtracted: bool".
- For lens17 facilitation (without touching pipeline): ensure mhc_matrix path documented and tested with non-identity; keep output linear post-demosaic. Add comment in demosaic:
  ```
  // Hook for future non-Riemannian / log / LUT color engine (lens17):
  // demosaic_rggb_mhc_matrix accepts Q12 sensor-sharpen or other B.
  // Callers in LookRenderer can supply precomputed m for per-pipeline constancy.
  ```
- BitReader: document divergence; if unifying, do in decompress + ljpeg files only (one agent per or shared session).

## Agent Handoffs (5+ sessions, one primary file per agent)

**Target document filename (amalgamation of assessed files):** DecompressDemosaicDngExifLjpeg.md (place in repo root or docs/ per team convention; last agent appends -DONE on completion).

**Agent 1 — decompress.rs owner**
If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md
Handoff: Bitstream chapter items for decompress. Keep bit-exact, tests, D1/D2. No new alloc tricks without policy. Prepare for potential shared reader later (no change now).

**Agent 2 — ljpeg.rs owner**
If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md
Handoff: Bitstream chapter for ljpeg. cps=1 specialize, inline, cache tuning only w/ data, keep pred=1 bail + tests. Ensure probe remains zero-entropy.

**Agent 3 — demosaic.rs owner**
If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md
Handoff: Full Chapter 2. MHC factor (core), optional normalize helper + tests, small band cleanup. This unblocks color science and long-term maintenance. Verify unroll + parallel paths unchanged for RGGB hot.

**Agent 4 — dng.rs owner**
If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md
Handoff: Chapter 3 + cross calls to demosaic normalize if added. Dedup parse, complete/ensure fused band path for RGGB, blit copy_from_slice, black handling, matrix comments for future. Keep parallel tile + timings.

**Agent 5 — exif.rs owner (and last cross agent)**
If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md
Handoff: Chapter 4 (minimal or none). Participate in cross Chapter 5 items that touch meta or require adding From/compat (if scope allows without new files). After your changes (or confirmation none needed), rename the review document to DecompressDemosaicDngExifLjpeg-DONE.md (append -DONE to the exact amalgamation name) and commit or note in PR.

**Additional sessions if splitting large chapters:** Agent for "unify BitReader across decompress+ljpeg" (touches 1+5 files, needs explicit ask), or "add full streaming facade" (would affect top APIs in 1+3+5, defer unless asked).

## Final 2-3 Paragraph Overview of Achieved Value
Implementing the amalgamated proposals (primarily the MHC single-source factoring in demosaic, black normalization surfaced early, parse dedup + band fusion completion in dng, minor specializes/caches in ljpeg, and cross hooks/comments) delivers a tighter, more maintainable native raw front-end. Peak memory drops via proven band paths, hot kernels stay fast or improve via specialization while duplication (biggest long-term drag on the advanced perceptual color work) is removed — one place to evolve the per-pixel math for sensor-sharpen, log geodesics, or Molchanov residuals later. Test surface expands slightly around normalization and fused paths; bit-exactness and port fidelity preserved.

Downstream, every visionary application benefits immediately: photogrammetry gets normalized linear + full calibration bundle for accurate digital twins; LLM/ML and AR plant recognition get the half-res + saliency "foveated" fast path plus rich per-shot metadata and clean bayer/rgb options for models; JXL encode sees fewer demosaic artifacts (less butteraugli waste, better perceptual quality); the non-Riemannian color engine receives a documented, matrix-capable linear input stage ready for sub-ms LUT/SIMD application in LookRenderer. The "telescope" is now more precise, lower power for real-time, and future-proof without scope creep — exactly the surgical, high-leverage changes that compound across the full progressive JXL + raw pipeline.

**End of document.** Last agent (exif + cross): after partial or full implementation of your assigned handoff(s), rename/move this review document to exactly DecompressDemosaicDngExifLjpeg-DONE.md (amalgamation of the five assessed files + -DONE appended). This signals completion for the set.