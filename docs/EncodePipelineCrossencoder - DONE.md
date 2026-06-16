# Encode / Pipeline / Cross-Encoder — 19-Lens Review & Implementation Handoffs

**Scope (only these files):**
1. `crates/raw-pipeline/src/casabio_encode.rs`
2. `crates/raw-pipeline/src/pipeline.rs`
3. `crates/raw-pipeline/tests/cross_encoder.rs`

**Date:** 2026-06-11. Findings amalgamated across lenses (strategic, API, stages, state, data structures, hot kernels, boundaries, support, owl, reversal, astronomy, ML, gaming, photogrammetry, Butteraugli, AR, non-Riemannian colour, gaps, birds-eye).

---

## Strategic map (Lens 1)

```
demosaic (lib.rs, out of scope)
  └─ rgb16 interleaved u16
       └─ pipeline.rs: [auto_wb_rggb] → [apply_luminance_nr] → [apply_unsharp_masks]
            → process / process_rgba / process_16bit   (pre_lut → 3×3 matrix → sat/vib → post_lut)
            → downscale_* / rotate_* / apply_orientation
       └─ casabio_encode.rs: encode_variants[_with_progressive][_from_rgb16]
            → resize (Lanczos3, image crate) → jpegxl-rs (libjxl) → VariantSet {thumb_300, preview_1080, full}
cross_encoder.rs: libjxl-encoded bytes → jxl-oxide decode  (gallery web decoder = jxl-oxide-wasm)
```

Data passed between files: `process_rgba` (pipeline.rs) produces RGBA8 consumed by `encode_variants_with_progressive` (casabio_encode.rs) via `encode_variants_from_rgb16`. `cross_encoder.rs` validates the encode→web-decode contract. The weakest links found: a **suspected channel-count mismatch at the jpegxl-rs boundary (P0)**, **full-buffer copies and duplicate full-res Lanczos passes** in the variant fan-out, a **448 KB LUT clone per call** on the parallel tone path, and a **test file that never verifies a single pixel**.

---

## Consolidated findings

Priorities: **P0** = correctness, verify immediately; **P1** = high-value bug/perf; **P2** = solid improvement; **P3** = feature proposal.

### casabio_encode.rs

| ID | Pri | Finding |
|----|-----|---------|
| CE1 | **P0** | **Suspected RGBA/RGB channel mismatch.** `enc.encode(&pixels, w, h)` is fed RGBA8 (w·h·4 bytes), but upstream jpegxl-rs `encode()` defaults the frame to 3 channels (RGBA requires `EncoderFrame::new(data).num_channels(4)` + `encode_frame`). If the dependency in use is upstream-like, libjxl reads the buffer as packed RGB → garbled channels/stride. No existing test checks pixel values, so this would pass CI. Note `set_jpeg_quality` is not an upstream 0.10 method — the dep may be a patched fork that handles 4ch; **verify against the actual dependency source first** (test CT1 settles it empirically). Regardless of outcome, encoding a constant A=255 alpha channel wastes bytes and encode time — preferred end state is a 3-channel RGB path. |
| CE2 | P1 | `unsafe { std::mem::transmute(19i32) }` / `transmute(13i32)` to build the frame-setting enum is UB-adjacent and silently version-fragile (enum repr/discriminant drift). Use the dependency's named variants (`FrameSetting::ProgressiveDc`, `FrameSetting::GroupOrder`); stop discarding errors with `let _ =` — map to `EncodeError::Jxl` or at least log. |
| CE3 | P1 | Two needless full-buffer copies: `rgba.to_vec()` in the no-resize arm of `encode_one` (~80 MB for 20 MP RGBA), and `src.to_vec()` inside `resize_rgba` to construct the `ImageBuffer`. Both removable with a borrowed slice + borrowed-container `ImageBuffer<Rgba<u8>, &[u8]>`. |
| CE4 | P1 | Thumb (300) and preview (1080) are each Lanczos-resized **from full resolution independently** — two full-res passes. Cascade instead: full → 1080 (one full-res pass), then 1080 → 300 (~12× cheaper). Quality loss at 300 px through a 1080 px intermediate is imperceptible (mipmap-chain principle, Lens 13). |
| CE5 | P2 | No input validation: `rgba.len() != w*h*4` or zero dims fall through to deep panics/opaque libjxl errors. Add an early `EncodeError::Input` check. |
| CE6 | P2 | Three variants encode sequentially. Under the `parallel` feature, `rayon::join` the three `encode_one` calls (each builds its own encoder; thread-safe). Near-linear wall-clock win on ingest batches. |
| CE7 | P2 | Thumb at 300 px uses `EncoderSpeed::Falcon` (effort 3) like the full image. At 300 px, `Lightning`/`Thunder` is visually indistinguishable and substantially faster (this is also the main Butteraugli-cost lever available in this layer — Lens 15). Keep Falcon for full (ratified default). Bench before/after on one corpus image. |
| CE8 | P2 | `VariantSet` reports only source `width`/`height`. Callers (manifests, pyramid gallery, IIIF `info.json`) need the actual encoded dims of thumb/preview without decoding. Add `thumb_w/h`, `preview_w/h`. |
| CE9 | P3 | **Saliency-guided progressive order** (Lenses 12/13/14/16): libjxl supports `GroupOrderCenterX/Y` (frame settings 14/15). Expose an optional `center: Option<(u32, u32)>` so Tauri can pass the subject location (EXIF focus point or ML detection) — progressive paints then reveal the organism first, not the geometric centre. Scale centre coords when the variant is resized. |
| CE10 | P3 | No cancellation or progress: gallery ingest can't abort a queued 20 MP encode. Add `encode_variants_cancellable(..., cancel: &AtomicBool, on_variant: impl FnMut(/*idx*/))` checking between variants (gaming frame-budget principle). |
| CE11 | P1 | `encode_variants_from_rgb16*` accepts `PipelineParams` but silently ignores `texture`/`clarity` (unsharp is a separate mutating pass the caller must run first). Footgun: a caller setting clarity gets nothing. Either apply `apply_unsharp_masks` on a mutable copy when nonzero, or `debug_assert!`+document that the direct-feed path requires pre-applied unsharp. |
| CE12 | P3 | `preview_1080` always encodes with `dc=0, order=0`, yet it is the lightbox's progressive paint source. Passing `group_order` (and centre) to the preview too is nearly free and improves perceived latency. |

### pipeline.rs

| ID | Pri | Finding |
|----|-----|---------|
| PL1 | P1 | **Parallel tone path clones ~448 KB of LUTs on every call, including cache hits** (`c.pre_r.clone()` etc.). The non-parallel path was already fixed (comment says so); the parallel path was not. Store LUTs as `Arc<Vec<u16>>`/`Arc<Vec<u8>>` — clone becomes a refcount bump. Hits every Tauri slider tick. |
| PL2 | P2 | The unsharp blend loops in `apply_unsharp_masks` and the NR blend in `apply_luminance_nr` are scalar `while` loops even under `parallel` — on a 117 MB rgb16 buffer the blur is parallel but the blend is not. Use `par_chunks_mut` (row-sized chunks) under the feature flag, mirroring the blur. |
| PL3 | P2 | `downscale_rgb16_into`/`downscale_rgb8_into` integer fast path (exact factors) is single-threaded even with `parallel`; the float path is parallel. Parallelize the fast path with the same `par_chunks_mut(dw*3)` row pattern. |
| PL4 | P2 | `gaussian_kernel_13` sums to 0.9998 → ~0.02 % darkening per blur pass (compounds when texture+clarity both run). Set centre tap to `0.1372` so the kernel sums to 1.0 exactly. 5-tap already sums to 1.0. |
| PL5 | P2 | Per-pixel `par_chunks_mut(3)` (and `(4)`) creates maximal split granularity. Add `.with_min_len(4096)` (pixels) to the three parallel tone loops to cut rayon scheduling overhead on small (lightbox-sized) buffers. |
| PL6 | P2 | Six near-identical copies of the param-derivation + LUT-cache-ensure block (3 fns × 2 cfg arms). Extract `fn derive_tone_inputs(&PipelineParams) -> ToneInputs` and `fn ensure_lut(...)` helpers. This is risk reduction, not style: PL1's fix touches all six sites; future post16-style additions have already shown divergence pressure. |
| PL7 | P3 | `auto_wb_rggb` doc says "samples every 4×4 block" but code strides 8 (`x += 8; y += 8`), and silently assumes RGGB CFA. Fix the comment; note the CFA assumption in the doc. (Behaviour itself is correct as the gray-world *fallback* — camera WB stays authoritative.) |
| PL8 | P2 | `process*` silently truncate when `rgb16.len() % 3 != 0` (zip stops early; remainder undefined-by-omission). Add `debug_assert_eq!(rgb16.len() % 3, 0)` to the three entry points. |
| PL9 | P3 | **Histogram export for auto-tone** (astronomy lens — photometry before stretch): `pub fn luma_histogram(rgb16: &[u16]) -> [u32; 256]` (downsampled stride 4) enables auto-exposure/auto-contrast suggestions in the gallery and is the precondition for any future saliency/auto-enhance work. Cheap, read-only, parallelizable. |
| PL10 | P3 | **Scientific output mode** (Lenses 12/14/16 — ML recognition, photogrammetry, AR ID): the always-on baselines (sat 1.30, contrast 0.55, +1.4 EV) and sRGB EOTF are tuned for human viewing and *harm* radiometric fidelity for feature-matching and model inference. Add `pub fn process_linear16(rgb16, params) -> Vec<u16>` — pre_lut + matrix only, no baseline S-curve, no EOTF, sat=1.0 — for photogrammetry/ML consumers. Default human path unchanged (baselines stay global, per ratified tuning). |
| PL11 | P3 | **Perceptual-constancy hook** (Lens 17): the agreed integration point for the non-Riemannian colour engine is `apply_tone_math`. Prepare the seam now: add `PipelineParams.perceptual_lut: Option<Arc<Lut3d>>` where `Lut3d { n: u8 /*33*/, data: Vec<[f32;3]> }` with trilinear sampling, applied (when present) in place of the sat/vib block inside `apply_tone_math`. Design-only stub acceptable; full engine lands per "Non-Riemannian Fable Max Overview.md". |
| PL12 | P3 | Effective exposure range is asymmetric and undocumented: `(exposure_ev + 1.4).clamp(-3, 4)` means user +3 EV saturates at +2.6 effective. Document on the field; do **not** widen the clamp (highlight-preservation rule). |

### cross_encoder.rs

| ID | Pri | Finding |
|----|-----|---------|
| CT1 | **P0** | **Zero pixel verification anywhere.** The whole file proves only "bytes parse". Add a round-trip test: encode a known gradient, decode with jxl-oxide, compare RGB per pixel within lossy tolerance. This single test empirically settles CE1 (channel mismatch would show massive error). |
| CT2 | P1 | **Progressive compatibility untested against the gallery decoder.** `encode_variants_with_progressive(dc=2, order=1)` output is never decoded with jxl-oxide — yet group reordering + progressive DC is exactly the riskiest decoder-compat surface, and jxl-oxide-wasm *is* the production web decoder. Add encode(dc=2, order=1) → oxide decode → pixel check. |
| CT3 | P2 | No dimension assertions: decoded thumb long edge must be ≤ 300, preview ≤ 1080, aspect preserved, full unresized. Add to the existing test. |
| CT4 | P2 | `solid()` is misnamed — `(i & 0xFF)` produces a gradient/striped pattern, not a solid. Rename `gradient()`. (Reversal lens: the *unit* tests' true-solid fill is also why CE1 was never caught — uniform data hides channel shifts.) |
| CT5 | P2 | `encode_variants_from_rgb16` (the Tauri direct-feed path) never goes through the cross-decoder. Add a smoke: rgb16 gradient → variants → oxide decode + dims. |
| CT6 | P3 | Truncated-stream test: gallery progressive paints decode partial byte ranges. Feed jxl-oxide the first ~25 % of the `full` (dc=2, order=1) bytes via its partial/streaming API and assert a renderable DC frame. If the oxide API makes this brittle, document and skip. |

---

## Handoff sessions

Six sessions, five+ agents, **one file per agent**. Execute in numbered order — Session 1 gates Session 2.

---

### Session 1 — Agent A: `crates/raw-pipeline/tests/cross_encoder.rs` (CT1, CT2, CT3, CT4)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Tests first, deliberately: CT1 is the empirical probe for the P0 (CE1). Only touch `cross_encoder.rs`.

1. **CT4**: rename `solid` → `gradient` (it already generates `(i & 0xFF)`).
2. **CT1** — pixel round-trip:

```rust
#[test]
fn full_variant_roundtrips_pixels_through_oxide() {
    let (w, h) = (64u32, 64u32);
    let mut rgba = vec![0u8; (w * h * 4) as usize];
    for y in 0..h {
        for x in 0..w {
            let i = ((y * w + x) * 4) as usize;
            rgba[i] = (x * 4) as u8;
            rgba[i + 1] = (y * 4) as u8;
            rgba[i + 2] = ((x + y) * 2) as u8;
            rgba[i + 3] = 255;
        }
    }
    let v = encode_variants(&rgba, w, h, SourceType::Jpeg, false).unwrap();
    let img = JxlImage::builder().read(v.full.as_slice()).unwrap();
    let render = img.render_frame(0).unwrap();
    let fb = render.image_all_channels();
    let (buf, ch) = (fb.buf(), fb.channels());
    let mut max_err = 0f32;
    for p in 0..(w * h) as usize {
        for c in 0..3 {
            let want = rgba[p * 4 + c] as f32 / 255.0;
            max_err = max_err.max((buf[p * ch + c] - want).abs());
        }
    }
    assert!(max_err < 0.05, "max channel error {max_err} — channel-count mismatch at jpegxl-rs boundary if ≫ tolerance");
}
```

Adapt jxl-oxide API calls to the version in Cargo.lock; tolerance may need tuning to lossy q85 on this gradient (expect ≤ ~0.03 if encode is correct; ≈ catastrophic if RGBA is read as RGB). **If this test fails with garbled channels, report it as confirmation of CE1 and leave the test in (failing) for Session 2 to fix.**

3. **CT2** — progressive compat (this byte stream is what jxl-oxide-wasm must decode in production):

```rust
#[test]
fn progressive_dc2_center_out_decodes_with_oxide() {
    let rgba = gradient(512, 384);
    let v = encode_variants_with_progressive(&rgba, 512, 384, SourceType::Raw, false, 2, 1).unwrap();
    let img = JxlImage::builder().read(v.full.as_slice()).expect("oxide parse progressive");
    let render = img.render_frame(0).expect("oxide decode progressive");
    assert_eq!(img.width(), 512);
    assert_eq!(img.height(), 384);
    let _ = render.image_all_channels();
}
```

4. **CT3** — in the existing `libjxl_encoded_variants_decode_with_oxide`, assert decoded dims: thumb long edge ≤ 300, preview ≤ 1080, full == 1024×768, aspect ratio within ±1 px.

Verify: `cargo test --test cross_encoder` (with default features so `jxl-encode` is on).

---

### Session 2 — Agent B: `crates/raw-pipeline/src/casabio_encode.rs` — correctness (CE1, CE2, CE5, CE11)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

1. **CE1** — read the *actual* jpegxl-rs source in the cargo registry/patch (note: `set_jpeg_quality` is not upstream 0.10, so this may be a fork) and determine how `encode(&[u8], w, h)` derives channel count.
   - If it defaults to 3 channels: the RGBA input is being misread. Fix explicitly:
   ```rust
   use jpegxl_rs::encode::EncoderFrame;
   let frame = EncoderFrame::new(pixels).num_channels(4);
   let result: EncoderResult<u8> = enc
       .encode_frame(&frame, w, h)
       .map_err(|e| EncodeError::Jxl(e.to_string()))?;
   ```
   - Whether or not the bug is live, **prefer ending at 3-channel RGB**: alpha is constant 255 through this path; a 4th channel costs encode time, file size, and 25 % buffer memory. If you make `encode_one` take RGB, convert at the `encode_variants` entry (and see Session 6's note about feeding `process` instead of `process_rgba`). Session 1's CT1 test must pass either way.
2. **CE2** — replace both transmutes with the dependency's named enum variants (`FrameSetting::ProgressiveDc`, `FrameSetting::GroupOrder` or equivalent in the fork). Propagate or log errors instead of `let _ =`. If named variants don't exist in the dep, add them there is out of scope — then keep the numeric values but justify via a `const` with a comment pinning the libjxl header source, and remove the `unsafe` by using the dep's `from_repr`-style constructor if available.
3. **CE5** — at the top of `encode_variants_with_progressive`:
   ```rust
   if width == 0 || height == 0 || rgba.len() != (width as usize * height as usize * 4) {
       return Err(EncodeError::Input { expected: width as usize * height as usize * 4, got: rgba.len() });
   }
   ```
   (new `EncodeError::Input` variant; adjust ×4 to ×3 if CE1 lands as RGB.)
4. **CE11** — `encode_variants_from_rgb16_with_progressive`: if `params.texture != 0.0 || params.clarity != 0.0`, clone rgb16 to a mut buffer, run `crate::pipeline::apply_unsharp_masks`, then tone-map; otherwise current zero-copy path. Document the cost on the doc comment.

Verify: `cargo test -p raw-pipeline` (unit + cross_encoder). All Session 1 tests green.

---

### Session 3 — Agent C: `crates/raw-pipeline/src/casabio_encode.rs` — performance (CE3, CE4, CE6, CE7)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Run after Session 2 (same file; rebase on its changes).

1. **CE3** — kill both copies:
   ```rust
   fn resize_rgba(src: &[u8], sw: u32, sh: u32, dw: u32, dh: u32) -> Result<Vec<u8>, EncodeError> {
       use image::{imageops, ImageBuffer, Rgba};
       let img: ImageBuffer<Rgba<u8>, &[u8]> =
           ImageBuffer::from_raw(sw, sh, src).ok_or(EncodeError::Resize)?;
       Ok(imageops::resize(&img, dw, dh, imageops::FilterType::Lanczos3).into_raw())
   }
   ```
   and in `encode_one`, borrow instead of `to_vec()`:
   ```rust
   let resized;
   let (pixels, w, h): (&[u8], u32, u32) = match long_edge {
       Some(t) if width.max(height) > t => {
           let scale = t as f32 / width.max(height) as f32;
           let dw = (width as f32 * scale).round().max(1.0) as u32;
           let dh = (height as f32 * scale).round().max(1.0) as u32;
           resized = resize_rgba(rgba, width, height, dw, dh)?;
           (&resized, dw, dh)
       }
       _ => (rgba, width, height),
   };
   ```
2. **CE4** — cascade: restructure `encode_variants_with_progressive` to resize full → 1080 once, encode preview from it, then resize 1080 → 300 for the thumb. Cleanest shape: lift resizing out of `encode_one` (it then takes exact pixels + dims) and do the ladder in `encode_variants_with_progressive`. Handle the small-image case (source ≤ 1080: thumb resizes from source; source ≤ 300: no resize at all).
3. **CE6** — under `#[cfg(feature = "parallel")]`, encode the three variants with nested `rayon::join`; sequential fallback unchanged. Each closure builds its own encoder (already the case). Note: with CE4's cascade, preview-resize must complete before the thumb-resize — do resizes first (sequential ladder), then join the three *encodes*.
4. **CE7** — thumb uses `EncoderSpeed::Lightning`; preview/full stay `Falcon` (ratified). Thread a `speed` parameter through `encode_one`. Benchmark one real corpus image before/after (encode ms + bytes) and put the numbers in the commit message; if thumb quality visibly degrades or bytes grow > 10 %, revert to Falcon and log in rejected optimizations.

Verify: `cargo test -p raw-pipeline`; Session 1 round-trip + dims tests must stay green (they pin cascade quality).

---

### Session 4 — Agent D: `crates/raw-pipeline/src/pipeline.rs` — performance (PL1, PL2, PL3, PL4, PL5)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

1. **PL1** — `LutCache` fields → `Arc`:
   ```rust
   struct LutCache {
       // ...key bits unchanged...
       pre_r: Arc<Vec<u16>>, pre_g: Arc<Vec<u16>>, pre_b: Arc<Vec<u16>>,
       post: Arc<Vec<u8>>,
       post16: Option<Arc<Vec<u16>>>,
   }
   ```
   Construction sites wrap in `Arc::new(...)`; the parallel paths' `(c.pre_r.clone(), …)` become refcount bumps; non-parallel borrow-in-place paths compile unchanged via `Deref`. This removes a ~448 KB allocation+copy per `process*` call on the Tauri parallel path.
2. **PL2** — parallelize the texture/clarity blend loops in `apply_unsharp_masks` and the blend in `apply_luminance_nr` under `parallel`: `rgb16.par_chunks_mut(row)…zip(blurred.par_chunks(row))` or flat `par_iter_mut().zip()` with `.with_min_len(64 * 1024)`. Keep scalar loops for `not(parallel)`.
3. **PL3** — integer fast paths of `downscale_rgb16_into` / `downscale_rgb8_into`: same row-parallel pattern as the float path (`par_chunks_mut(dw * 3).enumerate()`, computing `dy` from the chunk index). Keep serial under `not(parallel)`.
4. **PL4** — `gaussian_kernel_13` centre tap `0.1370` → `0.1372` (kernel then sums to 1.0000; current 0.9998 darkens ~0.02 % per pass and compounds across texture+clarity).
5. **PL5** — add `.with_min_len(4096)` to the per-pixel `par_chunks_mut(3/4).zip(...)` loops in `process`, `process_rgba`, `process_16bit`.

Do **not** touch BASELINE_* constants, the VTILE=128 vertical blur (ratified by prior benchmarks), or add new tunables.

Verify: `cargo test -p raw-pipeline` (rotate + casabio unit tests); optional: run the `#[ignore]` rotate bench to confirm no regression; for PL1, a quick `process()` loop timing before/after with `--features parallel` in the commit message.

---

### Session 5 — Agent E: `crates/raw-pipeline/src/pipeline.rs` — correctness, hygiene & seams (PL6, PL7, PL8, PL12, optional PL9)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Run after Session 4 (same file).

1. **PL6** — extract the duplicated derivation + cache-ensure logic:
   ```rust
   struct ToneInputs { exp_gain: f32, wb_r: f32, wb_g: f32, wb_b: f32, tone: TonePost, sat: f32, vib: f32, vib_zero: bool }
   fn derive_tone_inputs(p: &PipelineParams) -> ToneInputs { /* current 25-line block, once */ }
   fn ensure_lut(cache: &mut Option<LutCache>, p: &PipelineParams, ti: &ToneInputs, need16: bool) { /* rebuild-if-stale + post16 backfill */ }
   ```
   Then each of the six cfg arms shrinks to `derive` + `ensure` + its loop. Behaviour-preserving refactor only — no semantic change; all existing tests must pass unmodified.
2. **PL8** — `debug_assert_eq!(rgb16.len() % 3, 0)` at the top of `process`, `process_rgba`, `process_16bit`.
3. **PL7** — fix `auto_wb_rggb` doc: sampling stride is 8 (one RGGB quad per 8×8 block), and the function assumes an RGGB CFA at (0,0); behaviour unchanged (gray-world remains fallback-only).
4. **PL12** — document on `exposure_ev`: effective gain is `(exposure_ev + BASELINE_EXP_EV).clamp(-3, 4)`, so the user-facing +3 saturates at +2.6 effective. Doc only; do not widen the clamp (highlight preservation).
5. **PL9 (optional, small)** — if time permits:
   ```rust
   /// 256-bin Rec.709 luma histogram of a tone-source rgb16 buffer (stride-4 subsample).
   pub fn luma_histogram(rgb16: &[u16]) -> [u32; 256] { /* luma >> 8 binning */ }
   ```
   Foundation for gallery auto-tone; read-only, no pipeline behaviour change.

Verify: `cargo test -p raw-pipeline` — zero behavioural diffs expected.

---

### Session 6 — Agent F: `crates/raw-pipeline/src/casabio_encode.rs` — features (CE8, CE9, CE10, CE12) + Agent A follow-up tests (CT5, CT6)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Agent F edits only `casabio_encode.rs`; the CT5/CT6 tests go to a re-spawn of Agent A on `cross_encoder.rs` (one file per agent holds).

1. **CE8** — add `thumb_w/thumb_h/preview_w/preview_h: u32` to `VariantSet`, filled from the cascade's computed dims (with CE4 they're already in hand). Update unit tests.
2. **CE9** — saliency centre:
   ```rust
   #[derive(Clone, Copy, Debug, Default)]
   pub struct ProgressiveOpts {
       pub progressive_dc: u32,            // 0/1/2
       pub group_order: u32,               // 0 scanline, 1 center-out
       pub center: Option<(u32, u32)>,     // subject coords in SOURCE image space
   }
   ```
   New entry `encode_variants_progressive_opts(rgba, w, h, source, hq, opts)`; existing `_with_progressive` delegates with `center: None` (API unchanged). In `encode_one`, when `group_order == 1` and centre set, scale coords by the variant's resize factor and set frame options `GroupOrderCenterX` (14) / `GroupOrderCenterY` (15) via the named enum from Session 2. This lets EXIF focus point or an ML detector drive which groups paint first — the organism, not the geometric centre.
3. **CE12** — with `ProgressiveOpts` in hand, apply `group_order` (+centre) to `preview_1080` as well as `full`; keep `progressive_dc` full-only (size cost on small images).
4. **CE10** — `pub fn encode_variants_cancellable(..., opts, cancel: &std::sync::atomic::AtomicBool) -> Result<VariantSet, EncodeError>` with a new `EncodeError::Cancelled`; check `cancel` before each variant encode. Existing fns unchanged.
5. **Agent A follow-up (cross_encoder.rs)** — CT5: rgb16 gradient → `encode_variants_from_rgb16` → oxide decode + dims. CT6: truncated-stream DC render of the first ~25 % of a `(dc=2, order=1)` full stream via jxl-oxide's partial-input API; if the API fights back, document and omit with a comment.
6. **Cross-file note (do not implement without approval — touches files outside scope):** once CE1 lands as 3-channel RGB, `encode_variants_from_rgb16` should call `pipeline::process` (RGB8) instead of `process_rgba`, deleting the constant alpha entirely. Flag to the user; requires only this file if `encode_one` already takes RGB.

Verify: `cargo test -p raw-pipeline` + `cargo test --test cross_encoder`.

---

## What implementing this achieves

The correctness arm closes the single most dangerous hole in the Casabio upload path: today, not one test between the libjxl encoder and the production jxl-oxide-wasm decoder checks an actual pixel value, and the jpegxl-rs boundary plausibly misreads RGBA as RGB — the kind of defect that ships silently because magic bytes and decode calls all succeed. After Sessions 1–2, every byte stream the Tauri uploader produces — including the progressive, centre-out-ordered streams the lightbox depends on — is round-trip verified against the same decoder crate the web gallery runs, with dimensions, channel order, and lossy error bounds pinned. The unsafe enum transmutes and silently swallowed encoder errors disappear at the same time, so future libjxl/jpegxl-rs upgrades fail loudly instead of corrupting frame settings.

The performance arm attacks the ingest cost-centre from both sides of the FFI boundary. On the encode side: two full-resolution buffer copies and one redundant full-res Lanczos pass are eliminated, the three variants encode concurrently under rayon, and the thumbnail drops to a cheaper effort tier — together a meaningful cut to per-photo ingest latency on a 20 MP RAW, which directly compounds across a field-collection batch. On the tone-mapping side: the parallel path stops cloning 448 KB of LUTs on every slider tick, the unsharp/NR blends and integer downscalers gain the parallelism the rest of the pipeline already has, and a 0.02 % kernel-normalization darkening bug is corrected. None of it touches the ratified baselines, blur tiling, or effort defaults.

The feature arm seeds the platform's longer arc. Variant dimensions in `VariantSet` feed manifests and IIIF-style metadata without a decode. Saliency-guided group ordering turns progressive paints from "centre of the frame first" into "specimen first," with the centre suppliable by EXIF focus data today and a species detector tomorrow. Cancellation and per-variant progress make ingest queues responsive in the field. And the two pipeline seams — a radiometrically honest `process_linear16` for photogrammetry/ML consumers and the `Lut3d` slot inside `apply_tone_math` — are exactly the attachment points the digital-twin and non-Riemannian perceptual-constancy programmes need, prepared without disturbing the human-tuned viewing pipeline.
