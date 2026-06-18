# BSD JXL Decoder — Design Spec

**Date:** 2026-06-17
**Status:** Design proposed. Sister to the **BSD JXL Encoder** spec.
**Author:** David (brainstormed w/ Claude)

> **Sister document:** `docs/superpowers/specs/2026-06-17-bsd-jxl-encoder-design.md`.
> **Shared foundation (already built):** `docs/HANDOFF-bsd-jxl-ffi-2026-06-17.md` + the `crates/jxl-ffi` crate.
> **Executable plan:** `docs/superpowers/plans/2026-06-17-bsd-jxl-decoder.md`.

This is the decode half of the same idea the encoder spec describes. Where the
encoder spec says "encode," read "decode"; where it says "we are told the
geometry," read "we discover the geometry." Everything else — the ownership
model, the zero-copy discipline, the typed-enum / no-`transmute` rule, the
reset-on-error correctness, the generic `Sample` surface — is identical by
design. That is what makes it a *sister*, not merely a sibling.

---

## Strategic shape (the one idea)

> **One owned object holds the libjxl decoder handle. Feed it JXL bytes, get pixels back.**
> No hidden state. No buffer-lifecycle puzzles. Explicit lifetime. Reuse is visible.

Identical sentence to the encoder, one verb flipped. Everything below hangs off it.

---

## 0. Foundation status (what already exists)

Unlike the encoder spec (written before the FFI existed), the decoder lands on a
**finished** clean-room FFI:

- `crates/jxl-ffi` — builds static **BSD-3** libjxl (cmake, ClangCL, forced `/O2 /Ob2`), links `jxl jxl_cms jxl_threads hwy brotli{dec,enc,common}`, and runs `bindgen` over `wrapper.h`.
- `wrapper.h` already `#include`s `<jxl/decode.h>` **and** `<jxl/thread_parallel_runner.h>` → **every decode symbol and the multithread runner are already in the binding surface.** No FFI work is required to start; only the safe layer.
- `crates/jxl-ffi/src/lib.rs` ships the Phase-0 smoke test (`JxlDecoderVersion() > 0`). Green = toolchain proven.
- License: `MIT OR Apache-2.0`. No GPL.

**Consequence:** the decoder is a *pure safe-layer + port* job. The risky part (link + bindgen) is behind us.

---

## 1. Goal / Non-goals

**Goal:** An in-tree, **BSD-clean** JPEG XL *decoder* built directly on `jxl-ffi`,
replacing the **GPL-3.0** decode paths: `crates/raw-pipeline/src/jxl_lowlevel.rs`
(on `jpegxl-sys`) and the `jpegxl_rs::decode::decoder_builder` call in the native
bench. Reusable (held decoder handle), zero-copy on input *and* on output,
control-first, correctness baked in. Generic over output sample type
(`u8`/`u16`/`f16`/`f32`) and channel layout (interleaved + planar extra) — the
mirror of the encoder's `Frame<S>`.

**Why:** same licensing argument as the encoder. `jpegxl-sys` (used by
`jxl_lowlevel.rs`) and `jpegxl-rs` (used by the bench decode) are
**GPL-3.0-or-later**; linked into the shipped native artifact, the copyleft is
viral on distribution. libjxl itself is BSD-3. Our own thin bindings (`jxl-ffi`,
already done) → GPL gone, codec + speed unchanged.

**Non-goals (no live consumer — not ported):**
- **Encode** — the sister spec owns it (`jxl_encode.rs`).
- **JPEG reconstruction** decode (`JxlDecoderGetJPEGReconstruction…`).
- **Box / metadata / animation** multi-frame decode.
- **Full ICC colour-management readback.** Today's `jxl_lowlevel.rs` assumes sRGB
  output and does not call `JxlDecoderGetColorAsICCProfile`. We keep that exactly
  — a backend swap, not a behaviour change. Threading real colour profiles end to
  end is the same separate, pipeline-wide initiative the encoder spec defers (its §9).
- **WASM.** This decoder is **native-only** (`cfg(not(target_arch = "wasm32"))`,
  same guard as today). The browser JXL decode path stays on `web/pkg` +
  `bridge.cpp` (separate, already BSD). `StandardMultifileTest.mjs` exercises that
  WASM/worker path and is therefore **unaffected** by this change.

---

## 2. Architecture

```
decode_rgba8(jxl, &opts) -> Image<u8>        ← thin sugar for the dominant photo path
   = Decoder::new(opts)?.decode::<u8>(jxl, Channels::Rgba)

Decoder                                       ← THE object. Owns the *JxlDecoder handle (RAII; Drop destroys).
   .decode::<S>(jxl, ch)  -> Image<S>           reset between decodes; reset-on-error.
   .decode_into::<S>(jxl, ch, &mut Vec<S>)      zero-copy OUT into a caller-owned, reused buffer.
   .decode_progressive::<S>(jxl, ch, on_event)  FRAME_PROGRESSION + FlushImage; borrowed events.
   .time_full_decode(jxl) -> Duration           measurement-only path (no pixel retention).
   .set_raw(id, val) / opts.extra               escape hatch: any present/future libjxl decoder knob.
   │
   ▼
jxl-ffi  →  libjxl (BSD-3)
```

- **Reuse is explicit, not magic.** The ingest loop / tile fan-out each hold *one* `Decoder` and call `.decode()` repeatedly. `JxlDecoderCreate` (a cheap malloc) is paid once per held `Decoder`; `JxlDecoderReset` cleans state between decodes. Word-for-word the encoder's reuse model.
- **Nothing is "kept warm."** The handle is a passive heap object — no traffic, no heartbeat, no idle cost, **no timeout**. Lifetime = the Rust value's scope (RAII): `Drop` → `JxlDecoderDestroy`. A timeout would be wrong for the same reason it is wrong for the encoder: timeouts manage *pooled* resources with no clear owner. Single explicit ownership = deterministic destruction.
- **No thread-local pool** — rejected as hidden state (same as encoder). Under rayon (the JXTC tile path), each worker constructs its own `Decoder` (normal owned-value semantics).
- **The genuinely costly resource is the parallel runner.** Spawning OS threads per decode is real cost, so when `DecodeOptions.parallel` is set the `JxlThreadParallelRunner` is created **once** and held by the `Decoder` across decodes (scope-bound, never timeout-bound) — the encoder spec's "pool held across encodes" applied to decode. Default is **off** (single-threaded), which is exactly today's `jxl_lowlevel.rs` behaviour.

### 2a. The principled inversion vs the encoder

| Encoder (`Frame<S>`) | Decoder (`Image<S>`) |
|---|---|
| Caller **states** width/height/channels/bits → `SetBasicInfo`. | Decoder **discovers** them via `JxlDecoderGetBasicInfo` and reports them in `DecodedMeta`. |
| Input pixels **borrowed** (zero-copy in). | Output buffer **owned** and moved out — *or* written into a caller buffer (zero-copy out, see §2b). |
| Output bytes **retained** (saved to disk) → grow-then-move-out, no reuse buffer. | Output pixels **consumed** (viewer / metrics / stitch), often transient → **reuse-into-caller-buffer is the right call** (`decode_into`). |

The last row is the one place the decoder deliberately *diverges* from the
encoder's conclusion, and the divergence is grounded in the architecture docs
(see §10): the encoder rejected a persistent output buffer because its output is
saved; the decoder's output is frequently thrown away after one pass (a tile
stitched into a viewport, a frame measured then dropped), so eliminating the
per-decode allocation is the "remove movement / allocate once, reuse forever"
win the *Implementation Blueprint* and *Architecture Optimisation* docs call for.

### 2b. Zero-copy out (no reinterpret pass)

`decode_into::<S>` allocates/reuses a typed `Vec<S>` sized `w*h*channels`, then
hands libjxl the **byte span of that same buffer** (`as_mut_ptr() as *mut c_void`,
length `len * size_of::<S>()`). libjxl writes final pixels directly into the
typed Vec. There is **no** `Vec<u8>` → `Vec<S>` reinterpret/copy afterwards. One
owner, written once. (We request `JXL_NATIVE_ENDIAN`, so the bytes libjxl writes
are already native-endian `S`.)

---

## 3. Options surface

```rust
pub struct DecodeOptions {
    pub parallel: bool,            // attach a scope-bound JxlThreadParallelRunner (default: false = today's behaviour)
    pub allow_partial: bool,       // accept truncated input: NeedMoreInput returns the best flushed image instead of failing
    pub keep_orientation: bool,    // JxlDecoderSetKeepOrientation (default false = today's behaviour: libjxl applies EXIF orientation)
    pub limits: DecodeLimits,      // resource budget — refuse decompression bombs before allocating (see §5a)
    pub cancel: Option<Arc<AtomicBool>>, // cooperative cancellation, checked between libjxl steps (see §5a)
    pub read_color: bool,          // populate Image.color via JxlDecoderGetColorAsEncodedProfile (default false = parity)
    pub extra: Vec<(JxlDecoderInt, i64)>, // declarative escape hatch for any present/future decoder knob
}

impl Default for DecodeOptions { /* parallel/partial/keep/read_color = false, cancel = None,
                                    limits = "generous default ceiling" → byte-identical decode
                                    output to jxl_lowlevel.rs today (limits only *refuse*, never alter) */ }
```

The `limits`, `cancel`, and `read_color` knobs are the safety/observation surface detailed in **§5a**; they never change the *pixels* of a decode that succeeds within budget, so `DecodeOptions::default()` remains the parity contract.

- **`DecodeOptions::default()` reproduces today's `jxl_lowlevel.rs` exactly** — no runner, no partial, libjxl-applied orientation, sRGB out. This is the parity contract.
- **`parallel`** exists solely to restore the bench's multithreaded decode (`bench_jxl_decode` used a `ThreadsRunner`). libjxl MT decode is deterministic ⇒ byte-identical to ST ⇒ parity-safe either way; it only moves the timing number.
- **No speculative knobs.** Per the project rule "adaptive/heuristic changes require benchmark data; do not add tunables without evidence," the surface is the minimum that reproduces the two paths being replaced, plus the `extra` escape hatch. `JxlDecoderInt` is the typed `JxlDecoderProgressiveDetail`/option newtype from `jxl-ffi` — **no `transmute`**, mirroring the encoder's deletion of the `transmute(14i32)` hack.

There is no `Rate` analogue: rate is an encode-time decision baked into the
bitstream. Its decoder mirror is `DecodedMeta` (what the stream *says* it is),
which the decoder reads rather than sets.

---

## 4. Sample types & channels — fully general, all implemented

### Sample types (shared clean-room `Sample` trait, BSD)

The decoder **reuses the encoder's `Sample` trait** (defined once in a shared
`jxl_sample.rs`; the encoder extends the same file with its encode-only
`bits_per_sample()`). DRY across the two halves.

| Type | `JxlDataType` | Primary use |
|------|---------------|-------------|
| `u8`        | `JXL_TYPE_UINT8`   | SDR photos (dominant path) |
| `u16`       | `JXL_TYPE_UINT16`  | RAW masters / 16-bit tiles |
| `half::f16` | `JXL_TYPE_FLOAT16` | **HDR** |
| `f32`       | `JXL_TYPE_FLOAT`   | **hyperspectral / scientific** |

```rust
pub trait Sample: Copy + 'static {
    fn data_type() -> jxl_ffi::JxlDataType;
}
```

For decode, `Sample::data_type()` selects the **output** `JxlPixelFormat.data_type`
— the caller chooses the precision they want to read back, independent of the
stream's stored precision (libjxl converts). All four are unit-tested in
isolation (synthetic image → encode fixture → decode → compare). Dep: `half`
(MIT/Apache, BSD-compatible) for `f16`.

### Channels — interleaved + planar, both implemented

```rust
pub enum Channels { Gray, GrayAlpha, Rgb, Rgba }   // interleaved color request

pub struct Image<S: Sample> {
    pub width: u32,
    pub height: u32,
    pub channels: u32,                 // interleaved channel count actually produced (1/2/3/4)
    pub data: Vec<S>,                  // interleaved, len = width*height*channels
    pub extra: Vec<ExtraPlane<S>>,     // planar extra channels read back (depth/thermal/spectral/alpha-as-planar)
    pub meta: DecodedMeta,
}

pub struct DecodedMeta {
    pub num_color_channels: u32,       // from JxlBasicInfo
    pub has_alpha: bool,
    pub bits_per_sample: u32,          // stream's stored precision (informational)
    pub num_extra_channels: u32,
}

pub struct ExtraPlane<S: Sample> {
    pub kind: ExtraKind,               // mirrors the encoder's ExtraKind
    pub data: Vec<S>,                  // planar, width*height
}
```

- **Interleaved path** (photos): `Channels::Rgba` etc. via `JxlDecoderSetImageOutBuffer`.
- **Planar extra channels** (hyperspectral bands, depth, thermal): each read back with `JxlDecoderExtraChannelBufferSize` + `JxlDecoderSetExtraChannelBuffer`, the readback mirror of the encoder's `SetExtraChannelInfo`/`SetExtraChannelBuffer`. Discovered from `DecodedMeta.num_extra_channels`.
- *Caveat on record* (same as encoder §4): JXL transports many extra channels fine but is not a dedicated HSI codec; `Spectral` maps to libjxl `Optional`/`Unknown`.

---

## 5. Lifecycle, zero-copy, correctness

**Decoder owns:** the `*mut JxlDecoder` handle, and (only if `opts.parallel`) the
`*mut c_void` runner from `JxlThreadParallelRunnerCreate`. Nothing else persistent.

**Per `decode()`:**
1. `subscribe` — `JxlDecoderSubscribeEvents(BASIC_INFO | FULL_IMAGE [| FRAME_PROGRESSION])`; attach runner if held.
2. `input` — `JxlDecoderSetInput(jxl, len)` (**borrowed ptr — no copy**) + `JxlDecoderCloseInput`.
3. `loop` — drive `JxlDecoderProcessInput`:
   - `BASIC_INFO` → `GetBasicInfo` → fill `DecodedMeta`, size the output.
   - `NEED_IMAGE_OUT_BUFFER` → size a typed `Vec<S>`, hand libjxl its **byte span** (zero-copy out). Declare extra-channel buffers here too.
   - `FRAME_PROGRESSION` (progressive only) → `FlushImage` → emit borrowed `Progress` event.
   - `FULL_IMAGE` / `SUCCESS` → done; **move out** the typed Vec.
   - `ERROR` / `NEED_MORE_INPUT` → stop (in `allow_partial`, return last flushed image).
4. `JxlDecoderReset` so the held handle is clean for the next `decode()`.

**Correctness baked in (mirrors the encoder's review findings):**
- **Reset on every exit path**, success *and* error — a held/reused `Decoder` can never be poisoned by a prior failure (`Drop` resets too is unnecessary; `Drop` destroys).
- **Typed events, no `transmute`** — the bindgen output uses FFI-safe **NewType** enums (`JxlDecoderStatus(c_int)`), so the event loop maps the raw status through a typed `classify()` into a Rust `enum DecEvent` and `match`es on that. (Direct `match` on a NewType is impossible; this is the porting-time landmine — see the plan.)
- **Extra-channel readback is sized, never assumed** — `ExtraChannelBufferSize` before `SetExtraChannelBuffer`, every declared channel, or skip cleanly.
- **`Send`, not `Sync`** — same justification as the encoder (libjxl context looked up per-use, not stored). `Drop` calls `JxlThreadParallelRunnerDestroy` (if held) then `JxlDecoderDestroy`, in that order.

---

## 5a. Observation, control & safety surface

This section is the design-review pass (2026-06-17, §12) folded in. Its theme:
**a decoder is a source of information, not a pixel factory.** Each addition is a
*seam* that lets a consumer take less than a whole owned image, stop early, or
refuse hostile input — without growing the codec into a vision subsystem. Where a
suggestion would have put analysis/saliency/caching *inside* the decoder, it was
rejected (§12) and the seam points at the existing downstream layer instead.

### Borrowed analysis view (the biggest practical win)

Metrics rarely need ownership. The owned `Image<S>` (move-out) is for retention;
add a borrowed view for the measure-then-discard path:

```rust
pub struct ImageView<'a, S: Sample> {
    pub width: u32, pub height: u32, pub channels: u32,
    pub data: &'a [S],          // borrowed — lives for the closure scope only
    pub extra: &'a [ExtraPlane<S>],
    pub meta: &'a DecodedMeta,
}

impl Decoder {
    /// Decode, lend the buffer to `f`, then reset. No owned Vec escapes; no copy
    /// across the WASM/JS boundary; ideal for SSIM/Butteraugli/stats.
    pub fn decode_view<S, R>(&mut self, jxl: &[u8], ch: Channels,
                             f: impl FnOnce(ImageView<S>) -> R) -> Result<R, DecodeError>;
}
```

This is `time_full_decode`'s philosophy (measurement ≠ retention, §10 Lens 2)
made first-class, and the **correct home** for the rejected "analysis mode": the
closure calls the existing `crates/raw-pipeline/src/perceptual/*` SIMD kernels on
the borrow. The decoder computes **no** histogram/entropy/saliency itself — that
stays one layer up, fed by the view.

### Progressive control (early-out / backpressure)

The progressive callback gains a return value so a slower-than-libjxl consumer (or
a "good enough already" one — cf. `convergedByteEnd`) can stop. Each event carries
its pass index, since progressive quality is front-loaded (pass 1 ≫ pass 3):

```rust
pub enum ProgressControl { Continue, Stop }   // Stop → break loop, return best-so-far

pub enum DecodeEvent<'a, S: Sample> {
    Progress { pass: u32, width: u32, height: u32, pixels: &'a [S] },
    Final    { width: u32, height: u32, pixels: Vec<S> },
}
// on_event: FnMut(DecodeEvent<S>) -> ProgressControl
```

(`NeedMoreDetail`-style on-demand region refinement was rejected — libjxl's basic
progressive stream is forward-only, not a negotiable refinement protocol, §12.)

### Cooperative cancellation

`opts.cancel: Option<Arc<AtomicBool>>` is polled **between** `JxlDecoderProcessInput`
steps. Honest limit (same model as the scheduler's hard-cancel-between-chunks):
libjxl is synchronous *inside* a step, so cancellation is granular to a process
step, not instantaneous. On trip → `Err(DecodeError::Cancelled)`. Serves UI
scrubbing, tile streaming, server deadlines.

### Region decode (the AR / digital-twin seam)

Make ROI a named API *now*, even though the first implementation is decode-full-
then-crop, so call sites and the tile scheduler bind to the durable shape:

```rust
pub struct DecodeRegion { pub x: u32, pub y: u32, pub width: u32, pub height: u32 }

impl Decoder {
    pub fn decode_region<S>(&mut self, jxl: &[u8], ch: Channels, r: DecodeRegion)
        -> Result<Image<S>, DecodeError>;   // v1: full→crop. v2: JxlDecoderSetCropEnabled.
}
```

This is the same ROI need `jxtc.rs` (`decode_jxtc_region`) and the bench's
128/256 px subject crops already exercise; `decode_region` is where a future
libjxl-native crop lands without touching callers. An "attention-driven decode"
(cheap coarse pass → pick regions → deep-decode only those) composes from existing
primitives: `decode_progressive` (coarse) + `decode_region` (deep). The
*attention/priority* logic is upstream (saliency/gaze/zoom), not in the decoder.

### Resource limits (decompression-bomb guard)

A decoder is an attack surface. A JXL header can advertise a gigapixel canvas;
`ImageOutBufferSize` would then demand a vast allocation. Check the budget **before**
allocating the output buffer:

```rust
pub struct DecodeLimits { pub max_pixels: u64, pub max_output_bytes: u64 } // max_duration via opts.cancel + deadline
```

`width*height*channels*size_of::<S>()` over budget → `Err(DecodeError::LimitExceeded)`
before any large `Vec` is touched. Matters for the shipped browser/desktop/server
artifact.

### Typed, located errors (replaces bare `None`)

The rich object API returns `Result`, mirroring the encoder's `EncodeError` and
making failures debuggable ("entropy decode failed" beats "None"):

```rust
pub enum DecodeError {
    Create, BasicInfo, OutputAlloc, Process,   // stage tag
    LimitExceeded { pixels: u64, bytes: u64 },
    Cancelled,
    Tile { tile: u32, source: Box<DecodeError> }, // jxtc context
}
```

The drop-in compat free fns (`decode_jxl_rgba8`, the progressive wrappers) keep
returning `Option`/tuples by mapping `Err → None`, so legacy call sites stay a
path rename (§6).

### Observability metrics (so optimisation isn't folklore)

The measurement path returns movement counters, validating the "remove movement"
claims the design rests on (Architecture-Opt Validation, §10):

```rust
pub struct DecodeMetrics { pub input_bytes: u64, pub output_bytes: u64, pub allocations: u32, pub decode_ms: f64 }
impl Decoder { pub fn time_full_decode(&mut self, jxl: &[u8]) -> Result<DecodeMetrics, DecodeError>; }
```

### Colour-encoding readback (forward seam, default-off)

`opts.read_color` populates `Image.color: Option<ColorEncoding>` from
`JxlDecoderGetColorAsEncodedProfile`. **Off by default** → today's sRGB-assumed
parity is untouched. On → the consumer knows the real primaries/transfer instead of
rediscovering them from pixels. Pairs with decoding to **linear `f32`** (request a
linear profile) to feed Butteraugli/XYB (`perceptual/xyb.rs`) without the redundant
8-bit-sRGB detour — a real fusion win (Blueprint Ch.6), flagged for benchmark.
Exposure/timestamp were **not** added here: they live in EXIF (`exif.rs`), not the
JXL codestream (§12).

---

## 6. Module layout / migration

- **New:** `crates/raw-pipeline/src/jxl_sample.rs` — shared `Sample` trait + `data_type` mapping + endianness/pixel-format helpers. (Encoder consumes the same file; do not duplicate.)
- **New:** `crates/raw-pipeline/src/jxl_decode.rs` — `Decoder`, `DecodeOptions`, `Image<S>`, `DecodedMeta`, `ExtraPlane`, `Channels`, `DecodeEvent`, `DecodeTimings`, free-fn sugar (`decode_rgba8`, `decode_rgba16`). Sits on `jxl-ffi`, **not** `jpegxl-sys`.
- **New:** `crates/raw-pipeline/src/jxtc.rs` — the JXTC container path. The pure-math helpers (`parse_jxtc_header`, `overlapping_tile_indices`, `compute_tile_copy_rects`) move **verbatim** (they are already GPL-free); `decode_jxtc_region` is re-pointed at `Decoder`. (Separating container/tiling from codec follows the docs' layer-separation + file-focus guidance.)
- **`Cargo.toml` (raw-pipeline):** add `jxl-ffi` (native target dep) + `half`; add feature `jxl-decode = ["dep:jxl-ffi", "dep:rayon", "dep:half"]`; **remove** `jpegxl-sys` dep + the `jxl-lowlevel` feature.
- **`Cargo.toml` (root):** forwarder `jxl-lowlevel` → `jxl-decode`; drop the direct native `jpegxl-sys` dep.
- **Rewire call sites:** bench (`bench_jxl_decode` + `bench_jxl_decode_lowlevel_*`), `casabio_encode.rs` test (`decode_jxl_rgba8`), `tests/jxl_lowlevel_progressive.rs`.
- **Delete:** `crates/raw-pipeline/src/jxl_lowlevel.rs` (last, after all call sites are green).
- **Out of scope for this plan:** removing `jpegxl-rs` and the `vendor/` GPL dirs — that is the **encoder plan's** Phase 4. The two plans *jointly* eradicate GPL; this plan eliminates the GPL **decode** code and the direct `jpegxl-sys` dependency.

**Order is load-bearing (same rule as encoder §6):** build new modules → repoint call sites → drop dep/feature → delete old file → build. **Never delete-first.**

---

## 7. Testing / parity gate

- **Unit (module-local), gated `#[cfg(all(feature = "jxl-decode", feature = "jxl-encode"))]`:**
  - Each `Sample` type round-trips (encode fixture → `decode::<S>` → compare). A tiny **test-only** raw-FFI encode helper produces `u16`/`f16`/`f32`/planar fixtures (no GPL; deletable once `jxl_encode.rs` lands and the shared round-trip harness exists).
  - `Gray` / `Rgb` / `Rgba` interleaved; ≥1 planar extra channel read back.
  - Error path (truncated/garbage input) leaves the `Decoder` reusable (decode garbage → `None`, then decode a good image → `Some`).
  - `decode_into` reuses the buffer (capacity stable across two decodes of equal size).
  - Progressive: final event carries full image shape; non-final events (when present) precede it. (Ports the two existing `jxl_lowlevel_progressive.rs` tests.)
- **Backend-swap parity (the strongest gate), runs while both modules exist:** for the same JXL bytes, `jxl_decode::decode_rgba8(b) == jxl_lowlevel::decode_jxl_rgba8(b)` **byte-identical** (same libjxl underneath ⇒ must be bit-identical). This temporary test is deleted together with `jxl_lowlevel.rs`.
- **Independent-oracle parity:** `tests/cross_encoder.rs` already decodes with `jxl-oxide` (BSD, dev-dep) — kept as the cross-decoder check. Add a decode-side parity test: decode the same bytes with `jxl_decode` **and** `jxl-oxide`; assert pixel parity within tolerance.
- **Bench parity:** `raw_decode_bench.rs` still builds and runs; `decodeMs` reported via `jxl_decode` (MT path) is within tolerance of the prior `jpegxl-rs` MT number. Not "done" until green.
- **Property tests (§5a contracts):** `decode(encode(x)) ≈ x` across sample types and sizes; decode is deterministic (`parallel` output == serial output, already the Task 8 gate); a header over `limits.max_pixels` returns `LimitExceeded` and allocates nothing large; a pre-tripped `cancel` returns `Cancelled` and produces no image. These lock the safety surface as *behaviour*, not just compile-time shape.

---

## 8. Success criteria

1. All native JXL **decode** goes through `jxl_decode` on `jxl-ffi`. `jxl_lowlevel.rs` deleted; the direct `jpegxl-sys` dependency removed from both `Cargo.toml`s; the `jxl-lowlevel` feature replaced by `jxl-decode`.
2. `cargo build` + `cargo test` green for `raw-pipeline` (relevant feature sets) and the native bench.
3. Backend-swap parity: `jxl_decode` output is byte-identical to the prior `jxl_lowlevel` output on real assets (or within a stated tolerance only if a libjxl version skew is in play); `jxl-oxide` cross-decode agrees within tolerance.
4. One `Decoder` reused across an ingest loop and across JXTC tiles — no per-call create/destroy on the hot path; rayon workers each own a `Decoder`.
5. `u8`/`u16`/`f16`/`f32` + interleaved (gray/RGB/±alpha) + planar-extra all decode correctly (unit-tested).
6. No `transmute` for decoder IDs/status; `DecodeOptions::default()` is provably today's behaviour.
7. (Joint, with the encoder plan) GPL fully absent from the tree once both land.

---

## 9. Out of scope (on record — future initiatives)

The decoder *accepts* float and N-channel readback **now**. Using it end to end
needs the same separate, pipeline-wide work the encoder spec lists (its §9):
HDR (f16) view/tone pipeline; hyperspectral (f32, N-band) extra-channel model
threaded through pipeline → storage → false-colour view; full ICC colour
management. Plus the still-future native ROI crop (`JxlDecoderSetCropEnabled`)
once a JXTC reader or crop binding is wired — the `jxtc.rs` container path is the
stepping stone, not the destination. This decoder is deliberately ready ahead of
them and will not be the blocker.

**Deferred directions surfaced by the design-review pass (§12), recorded so they
are not re-proposed as decoder API:**
- **Gigapixel / out-of-core (`TiledImage`/`PixelStorage`, streaming sinks).** libjxl's
  public C decode writes one *contiguous* output buffer — there is no row-streaming
  sink in the basic API. The honest streaming unit is the **JXTC tile** (`jxtc.rs`),
  which already shards a huge image into independently-decoded tiles. A
  `PixelStorage` trait only earns its keep once a real >RAM asset exists; until then
  it is a speculative abstraction (YAGNI).
- **Attention-driven decode.** Composes from `decode_progressive` (coarse) +
  `decode_region` (deep). The saliency/gaze/priority that *chooses* regions is a
  perceptual/pyramid-layer concern feeding regions *into* the decoder, never logic
  *inside* it.
- **Cache derived invariants, not pixels** (cross-layer guidance for `jxl-cache` /
  pyramid, **not** the decoder, which owns no cache by layer invariant): a few-MB
  luminance-pyramid / feature-descriptor cache can replace a few-hundred-MB decoded-
  pixel cache. The decoder's `decode_view` is what lets that layer compute the
  invariant without ever retaining the pixels.

---

## 10. Grounding in the architecture docs

Explicit mapping to the four reference docs the brief named, so the design is
traceable rather than asserted:

- **`0 Architecture Optimization.md` — Lens 1 (Representation drives cost):** the
  generic `Sample` output means a metrics-only consumer can decode `u8` while a
  scientific consumer decodes `f32` from the *same* bytes; the representation is
  chosen at the consumer, not forced globally.
- **Lens 2 (Shared artifacts create hidden coupling):** `time_full_decode`
  (measurement, no pixels) is split from `decode`/`decode_into` (pixels). A timing
  or hash consumer never inherits the cost of retaining a frame — the exact
  decoupling *Core Hot Files* flags for the perceptual-metrics path (don't drag
  the expensive RGBA representation where only numbers are needed).
- **Lens 3 (Event-centric vs object-centric):** `decode_progressive` emits
  `DecodeEvent { Progress{w,h,borrowed pixels}, Final{…} }`, not a stream of owned
  frames. Consumers that only need "a pass landed, here are dims + timing" read the
  event without copying. (Generalises the borrowed/owned split already in
  `jxl_lowlevel.rs`.)
- **Lens 4 / Blueprint Ch.1 (explicit budgets, zero-allocation streaming):**
  `decode_into` is "allocate once, reuse forever" — the ring-buffer discipline
  applied to decode output; no per-decode `Vec` on the hot tile/ingest path.
- **Blueprint Ch.3 (pixel layout) & Ch.6 (kernel fusion):** planar extra-channel
  readback keeps alpha/depth/thermal *out* of the interleaved colour buffer
  (separate planes), and zero-copy-out (§2b) removes the reinterpret pass —
  "decode → output," not "decode → store → reinterpret → output."
- **Blueprint Ch.7 / Architecture-Opt Validation (quality gates):** parity is by
  **decoded-pixel** comparison (backend-swap byte-identity + `jxl-oxide` oracle +
  SSIM tolerance), never timing alone.
- **Optimisation hierarchy (architecture before SIMD):** the win here is
  structural (remove movement, decouple measurement from pixels, reuse the
  handle), not a micro-kernel. SIMD on decoded pixels already lives in
  `crates/raw-pipeline/src/perceptual/simd/*` and is untouched by this swap.
- **Don't force an irreversible representation (Blueprint Ch.6 fusion, Ch.9
  biological representation).** The generic `Sample` means the decoder never
  collapses to 8-bit sRGB unless asked: HDR/scientific consumers `decode::<f32>`
  (or `f16`) and keep dynamic range. Decoding straight to **linear `f32`** for the
  perceptual path skips the sRGB→linear reconvert before XYB — the metric consumes
  the representation it wants, not one it must undo. (The `RawFrame`/linear-master
  abstraction belongs to the RAW pipeline `pipeline.rs`, a layer below JXL decode —
  not duplicated here.)
- **Pick the narrowest sufficient precision (Architecture-Opt "numerical" /
  memory-bandwidth).** The perceptual kernels are memory-bound (per the project's
  perceptual-SIMD profiling), so a consumer that tolerates `u16`/`f16` should decode
  to it — fewer bytes through cache. The decoder enables the choice; it does not
  impose `f32`.
- **Determinism is already guaranteed, at the right layer.** libjxl MT decode is
  bit-identical to single-threaded (the Task 8 parity gate), so no `PrecisionMode`
  knob is needed on the decoder. Float-reduction non-determinism is a property of
  the *perceptual reductions*, addressed (if ever) in `perceptual/*`, not in decode.

---

## Design rationale — simplifications adopted (bird's-eye pass)

1. **Lands on the finished FFI.** No bootstrap; the decoder is safe-layer + port. The encoder spec's risky Phase 0 is already green.
2. **Mirrored the encoder's ownership model verbatim** (one owned `Decoder`, RAII, reset-on-error, no pool, no timeout) so the two halves read as one design.
3. **Inverted exactly one decision with evidence:** kept a reusable output buffer (`decode_into`) where the encoder rejected one — because decode output is consumed/transient, not saved, so "remove movement" favours reuse here (§2a, §10).
4. **Zero-copy on *both* sides:** borrowed input (like the encoder) *and* typed zero-copy output with no reinterpret pass (§2b).
5. **Minimum options surface:** `DecodeOptions::default()` *is* the parity contract. `parallel` preserves a bench number; the §5a safety/observation knobs (`limits`, `cancel`, `read_color`) only *refuse* or *observe* — they never alter the pixels of a decode that succeeds within budget — so default still equals today's behaviour.

---

## 12. Design-review pass — adopted & rejected (2026-06-17)

A multi-lens review (systems/memory → scientific-instrument → perception-platform)
proposed ~30 additions. Triaged against libjxl's public C API, the project's
layer invariants (`CLAUDE.md`), and YAGNI. Recorded here so rejected items are not
re-proposed (cf. `docs/rejected optimizations.md`).

### Adopted (folded into §3 / §5a / §7 / §9 / §10)

| Idea | Where | Why it fits |
|------|-------|-------------|
| Borrowed `ImageView` + `decode_view` | §5a | Biggest win; metrics need a borrow, not ownership. Extends the spec's own measurement/pixel split. |
| Region decode seam (`decode_region`) | §5a | Names the ROI shape now (v1 full→crop); binds AR/tile callers before libjxl-crop lands. |
| Progressive control (`Continue`/`Stop`) + pass index | §5a | Early-out/backpressure; quality is front-loaded. |
| Cooperative cancellation (`Arc<AtomicBool>`) | §5a | UI scrub / server deadline; honest between-steps granularity. |
| Typed, stage-located `DecodeError` | §5a | Debuggability; mirrors encoder `EncodeError`. |
| `DecodeLimits` (bomb guard) | §5a | Security: refuse gigapixel headers pre-alloc. |
| `DecodeMetrics` movement counters | §5a | Validates "remove movement" instead of asserting it. |
| Colour-encoding readback (default-off) + decode-to-linear | §5a/§10 | Forward colour-correctness seam; skips sRGB→linear reconvert for XYB. |
| Property tests (roundtrip/determinism/limit/cancel) | §7 | Locks the contracts as behaviour. |
| Prefer narrowest `Sample`; preserve range | §10 | Already enabled by generic `S`; made explicit. |

### Rejected (with reason)

| Idea | Reason |
|------|--------|
| `AnalysisFrame` / `DecodeMode::Analysis` (histogram/entropy in decoder) | Wrong layer — stats live in `perceptual/*`. The seam is `decode_view` → existing kernels, not a new subsystem in the codec. |
| `PixelSink` / `decode_into_sink` / `process_row` streaming | **Infeasible**: libjxl basic decode writes one contiguous buffer; no row-sink in the public API. Streaming unit is the JXTC tile (`jxtc.rs`). |
| `FrameRepresentation` / "decoder is a compiler" / preserve libjxl coefficients/IR | **Infeasible**: the public C API exposes pixels + basic-info only, never internal coefficients/Modular tree. Would require forking libjxl internals — the maintenance/licensing burden we are escaping. Derived reps (luminance/pyramid/features) are downstream of `decode_view`. |
| `FrameFeatures` / `FrameObserver` / `FrameConsumer` traits | YAGNI — no ≥2 wired consumers yet; `decode_view` already gives fan-out. Adds an observer framework before there is anything to observe. |
| `TiledImage` / `PixelStorage` trait | Speculative; gigapixel = JXTC tiles (covered) + §9 future. |
| Multi-tier `DecoderSession` cache (L1–L4) | Caching is outside the codec by layer invariant (`jxl-cache` / pyramid own it). |
| `Sample::ALIGNMENT` / `decode_aligned` | Premature; `Vec<S>` is already element-aligned; perceptual kernels own their alignment; `JxlPixelFormat.align` reachable via `extra` if ever needed. |
| `PrecisionMode { Fast, Deterministic }` | Decode is *already* deterministic (MT==ST gate). Float-reduction non-determinism is a perceptual-kernel concern, not decode. |
| `FrameMetadata.exposure` / `.timestamp` | Wrong layer — those are EXIF (`exif.rs`), not in the JXL codestream. |
| `RawFrame { linear_samples }` master type | RAW-pipeline layer (`pipeline.rs`); JXL decode ≠ RAW decode. Range preservation already enabled via generic float/16-bit `S`. |
| `ProgressControl::NeedMoreDetail` | libjxl progressive is a forward-only pass stream, not a per-region refinement protocol. |
| Parallel-runner reuse vs worker-local | Not an API change — a **validation task**: benchmark shared-vs-worker-local runner under the tile fan-out before assuming reuse wins (no tunable added without data, per `CLAUDE.md`). |

**Through-line:** every rejection keeps the decoder a thin, BSD-clean codec that is
a *source* of information (via borrowed views, regions, progressive events) rather
than a pixel factory — without letting analysis, saliency, caching, or out-of-core
storage leak into it. Those belong to the layers the seams point at.
