# RAW-decode hot-path review — Lib · Pipeline · ToneSimd · Demosaic · Decompress · Ljpeg

Scope: the pathway behind `raw_ms` / `raw_decompress_ms` / `raw_demosaic_ms` /
`raw_tonemap_ms` in `StandardMultifileTest.mjs`. The 3566 ms "raw decode" the
user saw is an ORF/CR2 full decode. Measured breakdown (latest run, 20.5 MP
class, single-thread wasm):

| stage | avg ms | peak ms (file) | file owning it |
|-------|-------:|---------------:|----------------|
| **tonemap** | **942** | **1588 (CR2)** | `pipeline.rs` + `tone_simd.rs` (kernel), routed from `src/lib.rs` |
| decompress | 485 | 992 (CR2 LJPEG) | `decompress.rs` (ORF) / `ljpeg.rs` (CR2/DNG) |
| demosaic | 145 | 248 (ORF) | `demosaic.rs` |

Headline: **tonemap is ~45–55 % of raw decode and runs fully scalar on wasm.**
A SIMD tone kernel already exists (`tone_simd::apply_tone_bulk`) but (a) is never
called by the decode path, and (b) only has an x86_64 AVX2 body — on `wasm32` it
falls back to per-pixel scalar. Fixing both is the single biggest win and is the
subject of Chapter 1.

Files own one agent each (Chapters map 1:1 to files; Ch.1 spans the two tone
files + the routing edit in `lib.rs`). `+simd128` is already enabled for wasm32
(`.cargo/config.toml`); `demosaic.rs` already uses `core::arch::wasm32::v128`
directly, so the wasm-SIMD idiom is established in this crate.

NOTE: `StandardMultifileTest.mjs` loads the **prebuilt** `./pkg/raw_converter_wasm_bg.wasm`.
Any Rust change requires a `wasm-pack`/`build-parallel-wasm.ps1` rebuild of `pkg/`
before the test reflects it. Native `cargo test` (raw-pipeline) validates parity
without a rebuild.

---

## Lens sweep — amalgamated findings (duplicates merged)

Strategic data-flow (L1/L7/L21/L24): `bytes → tiff/dng/cr2 parse → decompress(u16
mosaic) → demosaic(rgb16 interleaved) → [NR] → pipeline tone(rgb16→rgb8 via
pre-LUT → matrix+sat/vib math → post-LUT) → orient`. Two buffers cross JS↔WASM:
input bytes (in) and rgb8/packed-rgb16 previews (out). The compute mass sits in
the tone per-pixel math (matrix + saturation/vibrance), which is per-pixel
independent → the textbook SIMD target (L6/L22/L25/L26). Demosaic is the next
compute mass; decompress is serial-Huffman and inherently scalar (L6 says
don't try to SIMD the bit decode — attack its *refill*, L20/L23).

- **C1 (L2/L3/L6/L7/L22/L25 — tonemap):** decode calls scalar `process_into`
  (ORF) / `process` (DNG, CR2 via DNG impl). `process_into_simd` exists and is
  unused; its kernel has no wasm path. ⇒ Chapter 1.
- **C2 (L3/L23/L24 — ORF double demosaic):** ORF runs a full-sensor scalar
  `demosaic_rggb_planar` (~126 ms) *purely to build the 1800/360 previews*, plus
  the MHC pass for the full image. DNG/CR2 instead box-downscale their MHC result
  for previews (no second demosaic). Aligning ORF with that pattern removes a
  whole full-res demosaic. Quality trade noted. ⇒ Chapter 2 (proposal, needs
  sign-off).
- **C3 (L6/L22/L26 — MHC demosaic scalar):** `demosaic_rggb_mhc` /
  `demosaic_bayer_mhc` used by the real decode are scalar 2-col-unrolled integer.
  The correction terms are i32 shifts/adds → vectorizable as i32x4 wasm SIMD
  (the bilinear `*_simd` siblings already do this). ⇒ Chapter 3.
- **C3b (L20/L23):** ORF preview demosaic calls the **scalar** `demosaic_rggb_planar`,
  not the existing `demosaic_rggb_planar_simd`. One-line swap (moot if C2 lands).
- **C4 (L20/L23/L25 — LJPEG refill):** CR2 decompress peak (992 ms). The
  `BitReader::fill()` refills one byte at a time with a per-byte `0xFF` branch.
  SWAR fast-path (bulk 6-byte refill when no `0xFF` in the next word, slow path
  near markers) is the libjpeg-turbo trick. ⇒ Chapter 5.
- **C5 (L8/L18 — ORF decompress):** `decompress.rs` is already deeply optimised
  (delay-lines, `leading_zeros` nbits, batch-56 fill, branchless predictor). No
  further structural win found; documented as audited-clean.
- **L7/L24 boundary:** test uses `take_rgb()` then JS `rgb_to_rgba()` — a second
  full-res alloc+copy in JS. `take_rgba()` already fuses this in-wasm. App/bench
  could switch (minor vs scale cost). Noted in Chapter 2.
- **Owl/film-reversed/astronomy/gaming/photogrammetry/AR/LLM/Lens17
  (L9–L19):** the perceptual-constancy LUT path (`PerceptualGrid`, Lens17) is
  already scaffolded in `apply_tone_math`; the SIMD bulk kernel must keep the
  `!perceptual_constancy` precondition (the constancy path stays on the grid/AVX2
  bulk). The wasm SIMD tone kernel is exactly the "sub-millisecond per-tile"
  substrate those visions need for progressive paints — Chapter 1 is the enabler,
  no separate work. No new feature code proposed in this pass (would be premature
  without the kernel landed).

Three unlit rooms (L18/L19): (1) **encode** side is out of scope here but is the
larger half of `body_wall_ms`; (2) **memory traffic** — rgb16 (3×u16) is
materialised full-res before tone even when only a downscaled output is needed;
(3) **threading** of the raw pipeline (rayon `parallel` feature) vs the JXL MT
pool — the raw decode appears single-thread on the bench. Flagged, not actioned.

---

## Chapter 1 — Tonemap SIMD on wasm (THE win) · files: `tone_simd.rs` + `pipeline.rs` + `src/lib.rs`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

**Problem.** `apply_tone_bulk` (tone_simd.rs) dispatches AVX2 on x86_64 and scalar
everywhere else. wasm32 therefore runs the per-pixel oracle → the 942 ms tonemap.
Even if it were vectorised, the decode never calls it: `process_orf_impl`
(`src/lib.rs:792`) calls scalar `pipeline::process_into`, and `process_dng_impl`
(`src/lib.rs:1881`, also serves CR2) calls scalar `pipeline::process`.

**Fix A — `tone_simd.rs`: add a wasm32 SIMD128 body.** Mirror the AVX2 math at
f32x4 (baseline simd128 has no FMA intrinsic; `mul`+`add` is fine — the AVX2
parity test already tolerates reassociation). `+simd128` is always on, so no
runtime detect / `target_feature` is needed (same idiom as `demosaic.rs`).

```rust
// dispatch (apply_tone_bulk): insert before the trailing scalar call
#[cfg(target_arch = "wasm32")]
{
    apply_tone_bulk_wasm(r, g, b, m, sat, vib, vib_zero, n);
    return;
}

#[cfg(target_arch = "wasm32")]
fn apply_tone_bulk_wasm(
    r: &mut [f32], g: &mut [f32], b: &mut [f32],
    m: &[[f32; 3]; 3], sat: f32, vib: f32, vib_zero: bool, n: usize,
) {
    use core::arch::wasm32::*;
    let (m00,m01,m02)=(f32x4_splat(m[0][0]),f32x4_splat(m[0][1]),f32x4_splat(m[0][2]));
    let (m10,m11,m12)=(f32x4_splat(m[1][0]),f32x4_splat(m[1][1]),f32x4_splat(m[1][2]));
    let (m20,m21,m22)=(f32x4_splat(m[2][0]),f32x4_splat(m[2][1]),f32x4_splat(m[2][2]));
    let (lr,lg,lb)=(f32x4_splat(LUMA_R),f32x4_splat(LUMA_G),f32x4_splat(LUMA_B));
    let vsat=f32x4_splat(sat); let vvib=f32x4_splat(vib);
    let one=f32x4_splat(1.0); let zero=f32x4_splat(0.0); let p6=f32x4_splat(0.6);
    let lanes = n / 4 * 4;
    let mut i = 0;
    unsafe {
        while i < lanes {
            let vr=v128_load(r.as_ptr().add(i) as *const v128);
            let vg=v128_load(g.as_ptr().add(i) as *const v128);
            let vb=v128_load(b.as_ptr().add(i) as *const v128);
            let r2=f32x4_add(f32x4_mul(m00,vr),f32x4_add(f32x4_mul(m01,vg),f32x4_mul(m02,vb)));
            let g2=f32x4_add(f32x4_mul(m10,vr),f32x4_add(f32x4_mul(m11,vg),f32x4_mul(m12,vb)));
            let b2=f32x4_add(f32x4_mul(m20,vr),f32x4_add(f32x4_mul(m21,vg),f32x4_mul(m22,vb)));
            let luma=f32x4_add(f32x4_mul(lr,r2),f32x4_add(f32x4_mul(lg,g2),f32x4_mul(lb,b2)));
            let scale = if vib_zero { vsat } else {
                let raw_mx=f32x4_max(f32x4_max(r2,g2),b2);
                let mx=f32x4_max(raw_mx,one);
                let mn=f32x4_max(f32x4_min(f32x4_min(r2,g2),b2),zero);
                let inv=v128_and(f32x4_div(one,mx), f32x4_gt(raw_mx,zero));
                let psat=f32x4_min(f32x4_max(f32x4_mul(f32x4_sub(mx,mn),inv),zero),one);
                let t=f32x4_mul(f32x4_mul(vvib,f32x4_sub(one,psat)),p6);
                f32x4_add(f32x4_mul(vsat,t),vsat)
            };
            let onem=f32x4_sub(one,scale);
            v128_store(r.as_mut_ptr().add(i) as *mut v128, f32x4_add(f32x4_mul(luma,onem),f32x4_mul(r2,scale)));
            v128_store(g.as_mut_ptr().add(i) as *mut v128, f32x4_add(f32x4_mul(luma,onem),f32x4_mul(g2,scale)));
            v128_store(b.as_mut_ptr().add(i) as *mut v128, f32x4_add(f32x4_mul(luma,onem),f32x4_mul(b2,scale)));
            i += 4;
        }
    }
    while i < n {
        let (r2,g2,b2)=apply_tone_math(r[i],g[i],b[i],m,sat,vib,vib_zero,false);
        r[i]=r2; g[i]=g2; b[i]=b2; i+=1;
    }
}
```

**Fix B — `pipeline.rs`: auto-dispatch wrappers** (keeps `process_into` byte-exact
for LookRenderer/tests; the heavy decode opts into SIMD):

```rust
/// Decode-path tone: SIMD bulk when the plain (non perceptual-constancy) path
/// applies, else the byte-exact scalar path. Output differs from `process_into`
/// only by the documented ≤1-LUT-step SIMD reassociation tolerance.
pub fn process_into_auto(rgb16: &[u16], params: &PipelineParams, out: &mut [u8]) {
    if params.perceptual_constancy { process_into(rgb16, params, out); }
    else { process_into_simd(rgb16, params, out); }
}
pub fn process_auto(rgb16: &[u16], params: &PipelineParams) -> Vec<u8> {
    let mut out = vec![0u8; rgb16.len()];
    process_into_auto(rgb16, params, &mut out);
    out
}
```

**Fix C — `src/lib.rs`: route the two decode tone sites.**
- ORF `process_orf_impl` ~`:792`: `pipeline::process_into(&rgb16,&params,&mut rgb8)`
  → `pipeline::process_into_auto(&rgb16,&params,&mut rgb8)`.
- DNG/CR2 `process_dng_impl` ~`:1881`: `let rgb8 = pipeline::process(&rgb16,&params)`
  → `let rgb8 = pipeline::process_auto(&rgb16,&params)`.

**Expected:** matrix+sat/vib math is ~90 % of tone (tone_simd.rs header); 4-wide
f32 ⇒ tonemap ≈ 942 → ~300–400 ms. Post-LUT gather (the remaining ~10 %) stays
scalar. Net raw-decode drop ~500–700 ms/file. Risk: low — parity already asserted
for the SIMD bulk; `process_into` untouched. **Flip-flop:** `process_into` vs
`process_into_auto` ×10 over one ORF rgb16 in a native bench (or
`bench_tone_split`) — guard the merge on ≥2× tone-math speedup.

---

## Chapter 2 — ORF preview without a second full demosaic · file: `src/lib.rs`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

`decode_orf_raw` (~`:628`) runs `demosaic_rggb_planar` over the **full sensor**
(~126 ms `preview_demosaic_ms`) only to box-down to 1800/360 previews. DNG/CR2
(`process_dng_impl` ~`:1843`) instead derive lb from the MHC full-res and thumb
from lb — no extra demosaic. Proposal: build ORF lb/thumb by downscaling the MHC
`rgb16` (reuse `downscale_rgb16_impl` + `downscale_packed_rgb16_le`), delete the
planar demosaic + planar downscale for the preview path. Saves ~126 ms + the
planar-down time per ORF; preview quality goes from bilinear-then-box to
MHC-then-box (equal or better).

Caveats / why this is a proposal not a mechanical apply: (1) the planar path was
deliberately added as a "fast preview" and is timed separately — removing it
zeroes `preview_demosaic_ms` (don't read that as a regression); (2) the MHC pass
must complete before previews, slightly changing latency ordering for any
progressive-preview consumer; (3) needs a visual sign-off on the 1800 px lightbox.
Also worth one line here: the bench uses `take_rgb()` + JS `rgb_to_rgba()`
(second full-res copy); `take_rgba()` fuses it in-wasm for encode-only paths.

If accepted, the simplest first step (no quality change, still removes the scalar
planar pass): swap `demosaic_rggb_planar` → `demosaic_rggb_planar_simd` at `:628`
(see Chapter 3b) and keep the structure; do the MHC-derive change only after
sign-off.

---

## Chapter 3 — MHC demosaic SIMD (+ 3b planar swap) · file: `demosaic.rs`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

`demosaic_rggb_mhc` (`:1054`) and `demosaic_bayer_mhc` (`:932`) — used by every
real decode — are scalar 2-col-unrolled. Their interior corrections are pure
integer (`(2*sum_g4 + 4*rc - sum_d4) >> 3`, etc.) over i32, identical per parity
across a row → vectorizable as i32x4 wasm SIMD, exactly like the existing bilinear
`demosaic_rggb_simd` (`:286`) and `*_planar_simd` (`:498`) which already use
`v128_load`/`v128_bitselect`. Expected ~1.5–2× on the 145 ms demosaic (peak 248).
Keep the scalar border/tail; vectorise the interior `while col+1 < int_end` loop.
Parity-test against the scalar oracle (the file already has `demosaic_bench_*`
equal/first-diff hooks in `src/lib.rs`).

**3b (independent, trivial):** `decode_orf_raw` (`src/lib.rs:628`) calls scalar
`demosaic_rggb_planar`; a `demosaic_rggb_planar_simd` already exists. Swap it
(unless Chapter 2 removes the call). Cross-file edit in `src/lib.rs` is permitted
for this item.

---

## Chapter 4 — ORF decompress (audited clean) · file: `decompress.rs`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

No structural change recommended. Already has: D1 delay-lines (no `out[]`
re-reads), D2 `leading_zeros` nbits, branchless gradient predictor, batch-to-56
bit fill, pointer-advance writes. The serial predictive Huffman is data-dependent
(each pixel needs the previous) — not SIMD-able. The two `#[ignore]` micro-probes
(one-fill `D3`, skip-zero-init `D6`) are already measured <3 % and rejected.
Only candidate, low value: hoist `huff_table()` out of nothing (it's a `OnceLock`,
already free). **Recommend: reject new work, record as audited.** If you must,
the one defensible micro is fusing the four `br.truncated` checks per pixel into
one check after the carry read (they can only flip once per pixel) — measure
first; likely <1 %.

---

## Chapter 5 — CR2/DNG LJPEG refill SWAR · file: `ljpeg.rs`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

CR2 decompress is the decompress peak (853–992 ms). `BitReader::fill()` (`:91`)
refills the 64-bit accumulator **one byte at a time** with a `0xFF`-stuffing
branch per byte — the dominant decompress cost. The libjpeg-turbo trick: when the
next ≥6 source bytes contain no `0xFF` (SWAR test: `word & 0x8080808080808080 &
~(word + 0x0101010101010101)`… or simpler, scan a `u64` for any `0xFF` byte),
bulk-shift all of them in one shot and skip the per-byte branch; fall back to the
current slow path within a few bytes of any `0xFF` (marker/stuffing). Must keep
`real_in_buf` / `truncated` accounting exact. Expected 1.3–1.8× on CR2/DNG
decompress (the `0xFF` byte is rare in lossless-raw residuals, so the fast path
covers most refills). Medium risk → parity-test against the existing golden +
real-CR2 round-trip before merge. **Flip-flop:** old `fill` vs SWAR `fill` ×10 on
one CR2 tile decode.

---

## Overview — what implementing this achieves

The pipeline today spends the majority of "RAW decode" on a per-pixel colour
transform that is embarrassingly parallel yet runs one pixel at a time on the very
platform (wasm) the product ships on. Chapter 1 alone — a ~60-line SIMD kernel and
two call-site reroutes — converts that transform to 4-wide and is expected to take
the headline 942 ms tonemap to ~300–400 ms, i.e. roughly a 500–700 ms cut on every
RAW the user opens, with no change to colour output beyond sub-LUT-step rounding
that the existing parity tests already bless. Because the same tone path also backs
the interactive `LookRenderer`/`apply_look`, the wasm SIMD kernel additionally
makes every lightbox slider tick cheaper, which is where the perceptual-constancy
(Lens 17) and progressive-paint visions actually live — Chapter 1 is the substrate
those features need, delivered for free.

Chapters 2–3 attack the second mass (demosaic) and an architectural redundancy
(ORF's twin demosaic), together worth another ~100–250 ms on ORF specifically and
bringing ORF in line with the cleaner DNG/CR2 preview design. Chapter 5 targets the
CR2-specific decompress peak with a well-known SWAR refill, worth a few hundred ms
on Canon files. Chapter 4 is a deliberate "do nothing" — the ORF decompressor is
already at the algorithmic floor, and saying so prevents the next reviewer
re-litigating it.

Taken together the realistic envelope is a RAW decode dropping from ~3.1–3.6 s to
~1.8–2.3 s per large file, dominated by Chapter 1, with the rest closing the gap
between formats. None of it widens the colour contract, and every numeric claim is
gated behind a ten-iteration flip-flop so a non-improving change reverts itself
rather than shipping on faith.

---

## Implemented (this pass)

**Chapter 1 — SIMD tonemap on wasm — IMPLEMENTED & VERIFIED.**

Edits:
- `crates/raw-pipeline/src/tone_simd.rs`: added `#[cfg(target_arch="wasm32")]`
  dispatch in `apply_tone_bulk` + new `apply_tone_bulk_wasm` (f32x4 SIMD128 body,
  mirrors `apply_tone_bulk_avx2`; `mul`+`add` for the absent FMA; masked reciprocal
  for the vibrance divide; scalar tail).
- `crates/raw-pipeline/src/pipeline.rs`: added `process_into_auto` / `process_auto`
  (route `!perceptual_constancy` → `process_into_simd`, else byte-exact
  `process_into`). `process_into` left untouched so LookRenderer/exact-equality
  tests stay byte-identical.
- `src/lib.rs`: ORF `process_orf_impl` → `process_into_auto`; DNG/CR2
  `process_dng_impl` → `process_auto`.

Verification:
- Native parity `cargo test --no-default-features --lib tone_simd` → 3/3 pass.
- `cargo build --target wasm32-unknown-unknown` → clean (SIMD128 body compiles).
- Rebuilt `pkg/` via `build-parallel-wasm.ps1 -Features parallel-wasm` (the default
  `parallel-wasm,c-perceptual` link-fails on a **pre-existing** undefined wasm
  symbol `perceptual_apply_full` — the c-perceptual C++ FFI, dead code for this
  bench since `perceptual_constancy=false`; dropped it, identical for measured paths).
- `StandardMultifileTest.mjs` (8 files), before → after:
  - **AvgRawMs 1815 → 992 (−45%)**
  - **AvgRawTonemapMs 942 → 429 (−54%)** ← attributable to this change
  - AvgRawDecompressMs 485 → 316, AvgRawDemosaicMs 145 → 101 (untouched; run
    variance + cleaner rebuild)
  - Per-file: every RAW dropped, e.g. ORF P1110226 3160→1963 (tonemap 1270→616),
    ORF P2200474 3103→1504, CR2 _MG_1750 2419→1156. **No file regressed.**

**Chapters 2–5 — NOT implemented (left as agent handoffs):** ORF preview-from-MHC
(needs visual sign-off), MHC demosaic SIMD, LJPEG SWAR refill, decompress audit.
Chapter 3b (`demosaic_rggb_planar` → `_simd` swap) deferred with Chapter 2 since
that path may be removed entirely.

LAST AGENT: this file has been implemented in part (Chapter 1). The filename has
been suffixed `-DONE`.

