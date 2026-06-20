# RFC: Sink-oriented JXL decoder API (`decode(jxl, plan)`)

- **Status:** Draft — design only. No code in this change (per the casadecoder handoff, P3).
- **Date:** 2026-06-20
- **Scope:** `crates/raw-pipeline/src/jxl_casadecoder.rs` (the BSD `Decoder` object).
- **Supersedes nothing.** Additive; the current API stays as thin wrappers.

## 1. Motivation

The decoder's only shape today is **`decode(jxl) -> Image<S>`** (or a near relative).
Every entry point ends in a fully-materialised owned buffer or forces the caller to
pre-shape one:

| Entry point (current) | Destination | Cost it forces |
|---|---|---|
| `decode<S>(jxl, ch) -> Image<S>` | fresh owned `Vec<S>` | full alloc + materialise + ownership transfer |
| `decode_into<S>(jxl, ch, &mut Vec<S>)` | caller `Vec<S>` | alloc amortised, but still full materialise |
| `decode_view<S,R>(jxl, ch, f) -> R` | borrowed `&[S]` in closure | full materialise, then discard |
| `decode_region<S>(jxl, ch, r) -> Image<S>` | owned crop | **decodes the whole image**, then copies the rect |
| `decode_progressive<S>(jxl, ch, on_event)` | whole-buffer passes | consumer rescans the *entire* image after every refinement |
| `decode_jxtc_region(container, x,y,w,h) -> Vec<u8>` | owned RGBA8 rect | the one true ROI path; bypasses the above |

The remaining decode cost is dominated by **pixels touched, buffers copied, ownership
boundaries, and pipeline ordering** — not arithmetic or branches. The `-> Image<S>`
bias works against all four: it allocates, it copies across the FFI→Vec→caller
boundary, and it hands back a monolith the consumer must then re-walk.

Different consumers want fundamentally different destinations:

- **Analysis** (SSIM / Butteraugli / histogram): wants to *read* pixels once and keep
  a few scalars. Never needs an owned image.
- **Thumbnail**: wants a small surface, downscaled, ideally never holding the full res.
- **Viewport**: wants tiles written into a cache keyed by rect, refined progressively.
- **Full export**: genuinely wants the owned `Vec`/`Image`.

Today all four pay the full-materialisation tax. The fix is to make the **destination a
parameter**, not a fixed return type.

## 2. Proposal

Replace the implicit "return an `Image`" contract with an explicit **decode plan** that
names where pixels go:

```rust
pub struct DecodePlan<'s, S: Sample> {
    /// Viewport. `None` = whole image. A bounded rect is honoured by JXTC
    /// containers (real ROI) and emulated by full-then-crop for plain streams
    /// (see §4 — stable libjxl cannot bound a single-stream decode).
    pub region: Option<DecodeRegion>,
    /// Interleaved colour layout (today's `Channels`).
    pub channels: Channels,
    /// Where decoded pixels land. The heart of this RFC.
    pub sink: &'s mut dyn PixelSink<S>,
    /// Existing knobs, unchanged (parity contract preserved).
    pub options: DecodeOptions,
}
```

### 2.1 The sink trait

libjxl always writes interleaved samples into **one contiguous out-buffer** (bound via
`JxlDecoderSetImageOutBuffer`). The sink therefore has two jobs: (a) optionally *own*
that buffer so libjxl writes straight into the destination (zero-copy out), and
(b) react when a region is filled.

```rust
pub trait PixelSink<S: Sample> {
    /// Lend the contiguous interleaved buffer libjxl should fill for this frame
    /// (`len == width * height * channels`). Return `None` to let the engine use
    /// an internal scratch buffer it will then hand to `on_region` by reference
    /// (the borrowed/analysis model). Called at `NEED_IMAGE_OUT_BUFFER`.
    fn out_buffer(&mut self, w: u32, h: u32, channels: u32) -> Option<&mut [S]>;

    /// A region is now valid. For a one-shot decode this fires once with the full
    /// rect and `pass == FINAL`; for progressive it fires per flush. `pixels` is
    /// the live buffer (the same memory `out_buffer` lent, or engine scratch).
    /// Returning `Stop` ends the decode with best-so-far.
    fn on_region(&mut self, rect: PixelRegion, pass: Pass, pixels: &[S]) -> ProgressControl;
}

pub struct PixelRegion { pub x: u32, pub y: u32, pub w: u32, pub h: u32, pub stride: u32 }
pub enum Pass { Partial(u32), Final }
```

### 2.2 Built-in sinks (cover every current entry point)

| Sink | `out_buffer` | `on_region` | Replaces |
|---|---|---|---|
| `VecSink<S>` | owns + grows a `Vec<S>`, lends it | takes ownership at `Final` | `decode` |
| `CallerVecSink<'a,S>` | lends caller's `&mut Vec<S>` | no-op | `decode_into` |
| `AnalysisSink<F>` | `None` (engine scratch) | runs `F(&[S])`, keeps scalars | `decode_view` |
| `CropSink<S>` | `None` | copies overlap of `rect ∩ region` into a tight owned rect | `decode_region` |
| `TileCacheSink` | lends the cache slot for the tile | marks slot ready | `decode_jxtc_region` per-tile |
| `DownscaleSink` | `None` | box/area-filters into a small surface | (new) thumbnail |
| `GpuSink` | `None` | uploads `&[S]` to a staging buffer | (new) viewport upload |

The existing six functions become **one-line wrappers** that build the right sink and
call the core — no behavioural change, no break.

### 2.3 Progressive becomes region-based

Today `decode_progressive` re-exposes the **whole** buffer every flush, so a consumer
must rescan the full image after each refinement. With sinks, the engine reports the
**refined rect** (`on_region(rect, Pass::Partial(n), …)`), letting a viewport/cache
consumer touch only what changed. (libjxl's `FlushImage` still produces a full-image
flush internally; the win is the *consumer* no longer being forced to rescan — and a
future per-group flush API drops in here without changing the trait.)

## 3. Why this is the right shape

- **Destination is a parameter, not a return type.** The four consumer classes stop
  paying for materialisation they don't want.
- **Zero-copy out is preserved and generalised.** `out_buffer` lets the sink own the
  exact memory libjxl fills — today's `decode_into` zero-copy, now available to tile
  caches and caller surfaces too.
- **One engine, many destinations.** `run_full_into` / `run_progressive_into` already
  *are* the engine; this RFC only swaps their hard-coded `&mut Vec<S>` for
  `out_buffer()` + `on_region()`. Small, mechanical core change.
- **Composable.** `region + sink` expresses "decode this rect into that cache slot"
  directly — the JXTC fan-out stops being a special-cased function.

## 4. Constraints & explicit non-goals

These are load-bearing; ignoring them reintroduces already-rejected designs.

1. **No real single-stream ROI in libjxl.** The stable `JxlDecoder` API has no bounded-
   rectangle decode; `JxlDecoderSetImageOutBuffer` only sizes the *destination*. JPEG XL
   group reconstruction still runs for the whole frame. ⇒ `region` on a plain stream is
   **full-then-crop** (a `CropSink`). Genuine ROI savings come only from **JXTC tiling**,
   which stays the mechanism. The plan must not pretend otherwise.
2. **No unsafe `Vec<u16> → Vec<u8>` reinterpret.** The `u16` byte sink keeps the safe
   copy (`u16_samples_to_ne_bytes`); the allocator must free the layout it allocated.
   A byte-oriented sink may *receive* native-endian bytes, but never via layout punning.
3. **Parallel tile composite needs proven-disjoint destinations.** A `TileCacheSink`
   written from a rayon fan-out is sound only if each worker owns a non-aliasing slice.
   The current JXTC path composites **serially** for exactly this reason; the sink trait
   does not change that until disjoint ownership is proven (`split_at_mut` per tile rect).
4. **Parity contract.** `DecodeOptions::default()` must still reproduce legacy pixels
   exactly. Sinks only choose *where* pixels go, never *what* they are.
5. **RAII handle reuse intact.** The plan threads through the same owned `Decoder`;
   `JxlDecoderReset` on every exit path stays. No per-decode create/destroy, no internal
   scratch fields that conflict with caller-owned reuse.
6. **Progressive buffers still zero before exposure.** A sink that lends a buffer for a
   progressive decode inherits today's "zero before first flush" rule — partial passes
   expose uninitialised tail otherwise.

## 5. Migration (phased, additive)

1. **Phase 0 (this RFC):** agree the trait + plan shape.
2. **Phase 1:** introduce `PixelSink`, `VecSink`, `CallerVecSink`, `AnalysisSink`; refactor
   `run_full_into` to drive them. Re-express `decode`/`decode_into`/`decode_view` as
   wrappers. Net behaviour identical; tests unchanged + a sink-parity test added.
3. **Phase 2:** `CropSink` (wrap `decode_region`) and `TileCacheSink` (wrap the JXTC
   fan-out, still serial composite).
4. **Phase 3:** region-based progressive (`on_region` per flush); `DownscaleSink`,
   `GpuSink` as new capabilities.
5. **Phase 4 (separate RFC):** disjoint-ownership parallel tile composite, once proven.

No phase breaks callers; each is independently shippable and measurable (flipflop the
`AnalysisSink` path vs `decode_view` to confirm the materialisation saving is real before
widening).

## 6. Open questions

- **Trait object vs generic.** `&mut dyn PixelSink<S>` keeps `DecodePlan` non-generic over
  the sink and avoids monomorphising the engine per sink; a generic `<K: PixelSink<S>>`
  would inline but bloat. Lean dyn — the decode cost dwarfs one vtable call per frame.
- **Extra channels.** Planar extra planes (`ExtraPlane<S>`) need their own sink hook or a
  multi-plane `out_buffer`. Defer to Phase 1 detail; the colour buffer is the 99% path.
- **`Pass` granularity.** Is `Partial(u32)` enough, or do viewport consumers need the
  libjxl pass *kind* (DC vs AC)? Start minimal; extend if a consumer needs it.
- **Stride.** `PixelRegion::stride` is included for future sub-rect writes into a larger
  surface (thumbnail/viewport); the contiguous full-frame case sets `stride == w`.

## 7. Decision requested

Approve the trait/plan shape (§2) and the phasing (§5), or push back on the `out_buffer`
+ `on_region` split before any code lands. Nothing here is implemented yet.
