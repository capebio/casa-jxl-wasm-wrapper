# BSD JXL Decoder Implementation Plan

> **STATUS: ✅ DONE — 2026-06-18.** Implemented as the rich **JXL-CasaDecoder**
> object API in `crates/raw-pipeline/src/jxl_casadecoder.rs` (the file the task
> named), wired into the JXL pathway; all checkboxes below ticked. Deliberate
> deviations from the original plan text:
>
> - **File:** `jxl_casadecoder.rs` (not `jxl_decode.rs`). `lib.rs` keeps a
>   back-compat `pub use jxl_casadecoder as jxl_decode;` alias, so every existing
>   `jxl_decode::…` call site (bench, casabio test, progressive test) resolves
>   unchanged.
> - **Feature:** the repo ships the unified **`jxl-codec`** feature (encode +
>   decode on `jxl-ffi`), not a separate `jxl-decode`. All gates use `jxl-codec`.
> - **`Sample` trait:** already lives in `jxl_encode.rs` (shared, per spec §6) —
>   reused via `pub use crate::jxl_encode::Sample`; no separate `jxl_sample.rs`.
> - **Backend swap (old Tasks 2/6/9/11) + GPL teardown (Tasks 10/12):** the
>   `jpegxl-sys` decode path and `jxl_lowlevel.rs` were **already gone** before
>   this work (unified `jxl-codec` landing). This task ADDS the spec's
>   performance core — the reusable `Decoder` handle (RAII, `JxlDecoderReset`
>   between decodes, no per-call create/destroy), zero-copy `decode_into`,
>   borrowed `decode_view`, `decode_region`, planar extra readback — plus the
>   §5a / addendum safety surface (`DecodeError`, `DecodeLimits` bomb guard,
>   cooperative `cancel`, `DecodeMetrics`, progressive `ProgressControl`).
> - **Hot-path wiring:** JXTC `decode_jxtc_region` reuses one `Decoder` per rayon
>   worker (`map_init`); the native bench `bench_jxl_decode` holds one
>   `Decoder{parallel}` + one output buffer across all RUNS (`decode_into`).
> - **Tests:** the round-trip/parity suite is in-module unit tests
>   (`jxl_casadecoder::tests`, 18) minting bit-exact fixtures with the sister BSD
>   encoder in lossless mode (u8/u16/f16/f32, gray/RGB/RGBA, planar extra,
>   decode_into reuse, view, region, error-reuse, limits, cancel, MT==ST,
>   metrics, progressive + Stop). `jxl-oxide` remains the dev-dep oracle.
>
> **Verification (MSVC toolchain, 2026-06-18):** `raw-pipeline` lib tests
> **139 passed / 0 failed** (18 CasaDecoder); `jxl_lowlevel_progressive`
> integration **2/2**; `raw_decode_bench` builds + links.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the GPL-3.0 native JXL **decode** paths (`crates/raw-pipeline/src/jxl_lowlevel.rs` on `jpegxl-sys`, and the `jpegxl_rs::decode` call in the native bench) with an in-tree, BSD-clean decoder (`jxl_decode.rs`) built on the existing `crates/jxl-ffi`, mirroring the BSD encoder design (one owned handle, zero-copy, reuse, generic `Sample`).

**Architecture:** A safe layer over the already-built `jxl-ffi` (bindgen over BSD libjxl headers). One owned `Decoder` holds the `*mut JxlDecoder` (RAII, reset-on-every-path), borrows input (zero-copy in), writes final pixels directly into a typed `Vec<S>` (zero-copy out, no reinterpret), and is generic over `Sample` (`u8`/`u16`/`f16`/`f32`) and channel layout (interleaved + planar extra). Drop-in compat wrappers (`decode_jxl_rgba8`, progressive fns) keep call-site churn to path renames. Full design + rationale: **`docs/superpowers/specs/2026-06-17-bsd-jxl-decoder-design.md`**.

**Tech Stack:** Rust 2021, `crates/jxl-ffi` (bindgen NewType enums over libjxl BSD-3), `half` (f16), `rayon` (JXTC tiles), `jxl-oxide` (dev-dep parity oracle). Native-only (`cfg(not(target_arch = "wasm32"))`); MSVC Rust toolchain required (links MSVC-built static libjxl).

---

## Preconditions (verify once, before Task 1)

- [x] **P1. `jxl-ffi` builds + links.** This compiles libjxl via cmake on first run (several minutes); cached after.

  Run: `.\build-msvc.ps1 test --manifest-path crates\jxl-ffi\Cargo.toml`
  Expected: `test tests::links_to_libjxl ... ok` (proves cmake build + static link + bindgen end-to-end).

  > If `build-msvc.ps1` does not also select the MSVC **Rust** toolchain, prefix cargo with `+stable-x86_64-pc-windows-msvc`. `DEP_JXL_PATH` and `LIBCLANG_PATH` come from `.cargo/config.toml [env]` automatically.

- [x] **P2. Capture exact bindgen symbol names.** The safe layer references libjxl constants by their bindgen NewType names. Dump them so Task 1's `sym` aliases are correct:

  Run (PowerShell): `Get-ChildItem -Recurse -Filter bindings.rs (Resolve-Path .\target),(Resolve-Path .\crates\jxl-ffi\target) -ErrorAction SilentlyContinue | Select-Object -First 1 -Expand FullName`
  Then `Grep` that file for: `JXL_DEC_SUCCESS`, `JXL_DEC_BASIC_INFO`, `JXL_DEC_NEED_IMAGE_OUT_BUFFER`, `JXL_DEC_FULL_IMAGE`, `JXL_DEC_FRAME_PROGRESSION`, `JXL_TYPE_UINT8`, `JXL_TYPE_FLOAT16`, `JXL_NATIVE_ENDIAN`, `JxlThreadParallelRunner`, `JxlProgressiveDetail`.
  Expected: NewType associated consts, e.g. `impl JxlDecoderStatus { pub const JXL_DEC_SUCCESS: JxlDecoderStatus = JxlDecoderStatus(0); }`. **If** bindgen instead emitted module-level consts (`pub const JXL_DEC_SUCCESS: JxlDecoderStatus = …`), adjust only the `mod sym` RHS in Task 1.

---

## Test invocation (used by every task)

raw-pipeline is **not** a workspace member (`cargo test -p raw-pipeline` fails). Always target it by manifest path under the MSVC toolchain:

- **Full-feature (round-trip / parity tests, builds jpegxl-rs too):**
  `.\build-msvc.ps1 test --manifest-path crates\raw-pipeline\Cargo.toml --no-default-features --features "jxl-decode,jxl-encode,parallel"`
- **Lean (pure-FFI decode tests, no jpegxl-rs — faster):**
  `.\build-msvc.ps1 test --manifest-path crates\raw-pipeline\Cargo.toml --no-default-features --features "jxl-decode"`

Append `--lib` for unit tests, `--test <name>` for an integration test, `<test_fn>` to filter.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `crates/raw-pipeline/src/jxl_sample.rs` | Shared `Sample` trait (`data_type`, `bits_per_sample`) + endianness/pixel-format helpers. Consumed by decoder **and** the future `jxl_encode.rs`. | Create |
| `crates/raw-pipeline/src/jxl_decode.rs` | `Decoder`, `DecodeOptions`, `Image<S>`, `DecodedMeta`, `ExtraPlane`, `Channels`, `DecodeEvent`, `DecodeTimings`, the event loop, free-fn sugar + RGBA8 compat wrappers. | Create |
| `crates/raw-pipeline/src/jxtc.rs` | JXTC container path: pure-math (moved verbatim) + `decode_jxtc_region` re-pointed at `Decoder`. | Create |
| `crates/raw-pipeline/src/lib.rs` | Module decls + feature gates. | Modify |
| `crates/raw-pipeline/Cargo.toml` | Add `jxl-ffi`/`half` deps + `jxl-decode` feature; drop `jpegxl-sys` + `jxl-lowlevel`. | Modify |
| `Cargo.toml` (root) | Forwarder `jxl-decode`; drop native `jpegxl-sys`. | Modify |
| `src/bin/raw_decode_bench.rs` | Repoint both decode paths at `jxl_decode`; flip feature gate. | Modify |
| `crates/raw-pipeline/tests/jxl_decode_roundtrip.rs` | New unit/round-trip + FFI fixture helper. | Create |
| `crates/raw-pipeline/tests/jxl_decode_parity.rs` | Backend-swap byte-identity (vs `jxl_lowlevel`, temporary) + `jxl-oxide` oracle. | Create |
| `crates/raw-pipeline/tests/jxl_lowlevel_progressive.rs` | Repoint imports to `jxl_decode`. | Modify |
| `crates/raw-pipeline/src/jxl_lowlevel.rs` | The GPL decode path. | Delete (last) |

---

### Task 1: Shared `Sample` trait + dependency wiring

**Files:**
- Create: `crates/raw-pipeline/src/jxl_sample.rs`
- Modify: `crates/raw-pipeline/Cargo.toml`
- Modify: `crates/raw-pipeline/src/lib.rs:1-14`

- [x] **Step 1: Wire deps + feature.** In `crates/raw-pipeline/Cargo.toml`, add to `[features]`:

```toml
jxl-decode = ["dep:jxl-ffi", "dep:rayon", "dep:half"]
```

Add to `[dependencies]`:

```toml
half = { version = "2", optional = true }
```

Add to `[target.'cfg(not(target_arch = "wasm32"))'.dependencies]` (next to `jpegxl-sys`, which stays until Task 14):

```toml
jxl-ffi = { path = "../jxl-ffi", optional = true }
```

- [x] **Step 2: Declare the module.** In `crates/raw-pipeline/src/lib.rs`, after line 4 (`#[cfg(feature = "jxl-lowlevel")] pub mod jxl_lowlevel;`) add:

```rust
#[cfg(feature = "jxl-decode")]
pub mod jxl_sample;
#[cfg(feature = "jxl-decode")]
pub mod jxl_decode;
#[cfg(feature = "jxl-decode")]
pub mod jxtc;
```

- [x] **Step 3: Write `jxl_sample.rs`.**

```rust
//! Shared, clean-room `Sample` trait for the BSD JXL codec (encode + decode).
//!
//! Sits on `jxl-ffi` (bindgen over BSD-3 libjxl headers). No GPL.
//! The decoder uses `data_type()`; the future `jxl_encode.rs` additionally uses
//! `bits_per_sample()`. Defined once here so the two halves never duplicate it.

#![cfg(not(target_arch = "wasm32"))]

use jxl_ffi as ffi;

/// A pixel sample type libjxl can read/write: `u8`, `u16`, `half::f16`, `f32`.
pub trait Sample: Copy + 'static {
    /// libjxl `JxlDataType` for this sample (selects the in-memory pixel format).
    fn data_type() -> ffi::JxlDataType;
    /// (bits_per_sample, exponent_bits_per_sample) for `JxlBasicInfo` at encode
    /// time. Exponent 0 ⇒ integer; non-zero ⇒ float. Decode ignores this.
    fn bits_per_sample() -> (u32, u32);
}

impl Sample for u8 {
    fn data_type() -> ffi::JxlDataType { ffi::JxlDataType::JXL_TYPE_UINT8 }
    fn bits_per_sample() -> (u32, u32) { (8, 0) }
}
impl Sample for u16 {
    fn data_type() -> ffi::JxlDataType { ffi::JxlDataType::JXL_TYPE_UINT16 }
    fn bits_per_sample() -> (u32, u32) { (16, 0) }
}
impl Sample for half::f16 {
    fn data_type() -> ffi::JxlDataType { ffi::JxlDataType::JXL_TYPE_FLOAT16 }
    fn bits_per_sample() -> (u32, u32) { (16, 5) }
}
impl Sample for f32 {
    fn data_type() -> ffi::JxlDataType { ffi::JxlDataType::JXL_TYPE_FLOAT }
    fn bits_per_sample() -> (u32, u32) { (32, 8) }
}

/// Native-endian interleaved pixel format for `channels` channels of `S`.
pub fn pixel_format<S: Sample>(channels: u32) -> ffi::JxlPixelFormat {
    ffi::JxlPixelFormat {
        num_channels: channels,
        data_type: S::data_type(),
        endianness: ffi::JxlEndianness::JXL_NATIVE_ENDIAN,
        align: 0,
    }
}
```

- [x] **Step 4: Verify it compiles.**

Run: `.\build-msvc.ps1 build --manifest-path crates\raw-pipeline\Cargo.toml --no-default-features --features "jxl-decode"`
Expected: builds (jxl_decode.rs / jxtc.rs are empty next; create stubs `//! stub` if the module decl errors, then fill in Task 2/10). If `JXL_TYPE_UINT8` etc. mismatch, fix names per Precondition P2.

- [x] **Step 5: Commit.**

```bash
git add crates/raw-pipeline/Cargo.toml crates/raw-pipeline/src/lib.rs crates/raw-pipeline/src/jxl_sample.rs
git commit -m "feat(jxl-decode): shared Sample trait + jxl-ffi dep wiring"
```

---

### Task 2: `Decoder` + core event loop + `decode_rgba8` (u8 path)

**Files:**
- Create: `crates/raw-pipeline/src/jxl_decode.rs`
- Test: `crates/raw-pipeline/tests/jxl_decode_roundtrip.rs`

- [x] **Step 1: Write the failing test.** Create `crates/raw-pipeline/tests/jxl_decode_roundtrip.rs`:

```rust
#![cfg(all(feature = "jxl-decode", feature = "jxl-encode", not(target_arch = "wasm32")))]

use raw_pipeline::casabio_encode::{encode_variants, SourceType};
use raw_pipeline::jxl_decode::{decode_rgba8, Decoder, DecodeOptions, Channels, Image};

fn gradient(w: u32, h: u32) -> Vec<u8> {
    let mut v = vec![0u8; (w * h * 4) as usize];
    for y in 0..h { for x in 0..w {
        let i = ((y * w + x) * 4) as usize;
        v[i] = (x % 256) as u8; v[i+1] = (y % 256) as u8;
        v[i+2] = ((x + y) % 256) as u8; v[i+3] = 255;
    }}
    v
}

#[test]
fn decode_rgba8_full_recovers_dims_and_pixels() {
    let (w, h) = (128u32, 96u32);
    let rgba = gradient(w, h);
    let v = encode_variants(&rgba, w, h, SourceType::Jpeg, false).unwrap();

    // Free-fn compat shape: (Vec<u8>, w, h).
    let (px, dw, dh) = decode_rgba8(&v.full).expect("decode full");
    assert_eq!((dw, dh), (w, h));
    assert_eq!(px.len(), (w * h * 4) as usize);

    // Generic object API yields the same pixels.
    let mut dec = Decoder::new(DecodeOptions::default()).unwrap();
    let img: Image<u8> = dec.decode(&v.full, Channels::Rgba).expect("decode");
    assert_eq!((img.width, img.height, img.channels), (w, h, 4));
    assert_eq!(img.data, px);
    assert!(img.meta.num_color_channels >= 3);
}
```

- [x] **Step 2: Run to verify it fails.**

Run: `.\build-msvc.ps1 test --manifest-path crates\raw-pipeline\Cargo.toml --no-default-features --features "jxl-decode,jxl-encode,parallel" --test jxl_decode_roundtrip`
Expected: FAIL — `jxl_decode` unresolved / `Decoder` not found.

- [x] **Step 3: Write `jxl_decode.rs`** (the core; later tasks extend it):

```rust
//! BSD-clean native JPEG XL decoder over `jxl-ffi`. Sister to `jxl_encode.rs`.
//! One owned `Decoder` holds the libjxl handle (RAII, reset-on-every-path);
//! input borrowed (zero-copy in); final pixels written straight into a typed
//! `Vec<S>` (zero-copy out, no reinterpret). Generic over `Sample`.
//!
//! Native only. Design: docs/superpowers/specs/2026-06-17-bsd-jxl-decoder-design.md

#![cfg(not(target_arch = "wasm32"))]

use std::os::raw::{c_int, c_void};
use std::ptr;

use jxl_ffi as ffi;

pub use crate::jxl_sample::{pixel_format, Sample};

// --- Local symbol aliases. Verified against $OUT_DIR/bindings.rs (Precondition
//     P2). If bindgen emitted module-level consts, change only the RHS here. ---
mod sym {
    use jxl_ffi as ffi;
    pub const SUCCESS: ffi::JxlDecoderStatus = ffi::JxlDecoderStatus::JXL_DEC_SUCCESS;
    pub const BASIC_INFO: ffi::JxlDecoderStatus = ffi::JxlDecoderStatus::JXL_DEC_BASIC_INFO;
    pub const NEED_OUT: ffi::JxlDecoderStatus = ffi::JxlDecoderStatus::JXL_DEC_NEED_IMAGE_OUT_BUFFER;
    pub const FULL_IMAGE: ffi::JxlDecoderStatus = ffi::JxlDecoderStatus::JXL_DEC_FULL_IMAGE;
    pub const FRAME_PROGRESSION: ffi::JxlDecoderStatus = ffi::JxlDecoderStatus::JXL_DEC_FRAME_PROGRESSION;
}

/// Interleaved colour layout requested from the decoder.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Channels { Gray, GrayAlpha, Rgb, Rgba }
impl Channels {
    pub fn count(self) -> u32 {
        match self { Channels::Gray => 1, Channels::GrayAlpha => 2, Channels::Rgb => 3, Channels::Rgba => 4 }
    }
}

/// Geometry/precision discovered from the bitstream (`JxlBasicInfo`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DecodedMeta {
    pub num_color_channels: u32,
    pub has_alpha: bool,
    pub bits_per_sample: u32,
    pub num_extra_channels: u32,
}

/// A planar extra channel read back from the stream.
#[derive(Clone, Debug)]
pub struct ExtraPlane<S: Sample> { pub index: u32, pub data: Vec<S> }

/// Decoded image: interleaved colour `data` (+ optional planar `extra`).
#[derive(Clone, Debug)]
pub struct Image<S: Sample> {
    pub width: u32,
    pub height: u32,
    pub channels: u32,
    pub data: Vec<S>,
    pub extra: Vec<ExtraPlane<S>>,
    pub meta: DecodedMeta,
}

/// Decode-time knobs. `default()` reproduces the legacy `jxl_lowlevel.rs` behaviour exactly.
#[derive(Clone, Debug, Default)]
pub struct DecodeOptions {
    pub parallel: bool,
    pub allow_partial: bool,
    pub keep_orientation: bool,
}

/// THE object. Owns the libjxl decoder handle (+ optional scope-bound runner).
pub struct Decoder {
    handle: *mut ffi::JxlDecoder,
    runner: *mut c_void, // null unless opts.parallel
    opts: DecodeOptions,
}

// libjxl context is looked up per-use, not stored → Send, not Sync (mirrors encoder).
unsafe impl Send for Decoder {}

impl Decoder {
    pub fn new(opts: DecodeOptions) -> Option<Self> {
        unsafe {
            let handle = ffi::JxlDecoderCreate(ptr::null());
            if handle.is_null() { return None; }
            let runner = if opts.parallel {
                let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
                ffi::JxlThreadParallelRunnerCreate(ptr::null(), threads)
            } else { ptr::null_mut() };
            Some(Decoder { handle, runner, opts })
        }
    }

    /// Decode the full image to interleaved `S` pixels. Resets the handle on
    /// every exit path (success AND failure) so the Decoder is always reusable.
    pub fn decode<S: Sample>(&mut self, jxl: &[u8], ch: Channels) -> Option<Image<S>> {
        let out = unsafe { self.run_full::<S>(jxl, ch.count()) };
        unsafe { ffi::JxlDecoderReset(self.handle); }
        out
    }

    unsafe fn attach_runner(&self) -> bool {
        if self.runner.is_null() { return true; }
        ffi::JxlDecoderSetParallelRunner(self.handle, Some(ffi::JxlThreadParallelRunner), self.runner) == sym::SUCCESS
    }

    unsafe fn run_full<S: Sample>(&self, jxl: &[u8], channels: u32) -> Option<Image<S>> {
        if !self.attach_runner() { return None; }
        let events = (sym::BASIC_INFO.0 | sym::FULL_IMAGE.0) as c_int;
        if ffi::JxlDecoderSubscribeEvents(self.handle, events) != sym::SUCCESS { return None; }
        if ffi::JxlDecoderSetInput(self.handle, jxl.as_ptr(), jxl.len()) != sym::SUCCESS { return None; }
        ffi::JxlDecoderCloseInput(self.handle);

        let pf = pixel_format::<S>(channels);
        let mut info = std::mem::MaybeUninit::<ffi::JxlBasicInfo>::uninit();
        let mut meta = DecodedMeta::default();
        let (mut w, mut h) = (0u32, 0u32);
        let mut data: Vec<S> = Vec::new();

        loop {
            let status = ffi::JxlDecoderProcessInput(self.handle);
            if status == sym::BASIC_INFO {
                if ffi::JxlDecoderGetBasicInfo(self.handle, info.as_mut_ptr()) == sym::SUCCESS {
                    let bi = info.assume_init_ref();
                    w = bi.xsize; h = bi.ysize;
                    meta = DecodedMeta {
                        num_color_channels: bi.num_color_channels,
                        has_alpha: bi.alpha_bits > 0,
                        bits_per_sample: bi.bits_per_sample,
                        num_extra_channels: bi.num_extra_channels,
                    };
                }
            } else if status == sym::NEED_OUT {
                let mut size = 0usize;
                if ffi::JxlDecoderImageOutBufferSize(self.handle, &pf, &mut size) != sym::SUCCESS { return None; }
                let esz = std::mem::size_of::<S>();
                if size == 0 || size % esz != 0 { return None; }
                let elems = size / esz;
                // Zero-copy out: typed Vec<S>, libjxl writes straight into it.
                // Zero bit-pattern is valid for all Sample types (u8/u16/f16/f32),
                // so a memset (not a reinterpret copy) gives a defined partial buffer.
                data = Vec::with_capacity(elems);
                data.set_len(elems);
                ptr::write_bytes(data.as_mut_ptr(), 0, elems);
                if ffi::JxlDecoderSetImageOutBuffer(self.handle, &pf, data.as_mut_ptr() as *mut c_void, size) != sym::SUCCESS {
                    return None;
                }
            } else if status == sym::FULL_IMAGE || status == sym::SUCCESS {
                break;
            } else {
                // ERROR | NEED_MORE_INPUT | unexpected → stop.
                return None;
            }
        }
        if w == 0 || h == 0 || data.is_empty() { return None; }
        Some(Image { width: w, height: h, channels, data, extra: Vec::new(), meta })
    }
}

impl Drop for Decoder {
    fn drop(&mut self) {
        unsafe {
            if !self.runner.is_null() { ffi::JxlThreadParallelRunnerDestroy(self.runner); }
            ffi::JxlDecoderDestroy(self.handle);
        }
    }
}

// ── Drop-in compat free fns (RGBA8) — keep legacy call sites to path renames ──

/// Decode to RGBA8. Compat shape `(pixels, width, height)` matching the legacy
/// `jxl_lowlevel::decode_jxl_rgba8`.
pub fn decode_rgba8(jxl: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    let mut dec = Decoder::new(DecodeOptions::default())?;
    let img: Image<u8> = dec.decode(jxl, Channels::Rgba)?;
    Some((img.data, img.width, img.height))
}

/// Legacy alias.
pub use decode_rgba8 as decode_jxl_rgba8;
```

- [x] **Step 4: Run to verify it passes.**

Run: `.\build-msvc.ps1 test --manifest-path crates\raw-pipeline\Cargo.toml --no-default-features --features "jxl-decode,jxl-encode,parallel" --test jxl_decode_roundtrip`
Expected: PASS (`decode_rgba8_full_recovers_dims_and_pixels`).

- [x] **Step 5: Commit.**

```bash
git add crates/raw-pipeline/src/jxl_decode.rs crates/raw-pipeline/tests/jxl_decode_roundtrip.rs
git commit -m "feat(jxl-decode): Decoder + zero-copy event loop + decode_rgba8"
```

---

### Task 3: Generic `Sample` decode (u16/f16/f32) + gray/RGB + FFI fixture helper

**Files:**
- Modify: `crates/raw-pipeline/tests/jxl_decode_roundtrip.rs`
- (No new impl — Task 2's `run_full::<S>` is already generic. This task proves it for every type and adds the fixture helper used here + in Task 5.)

- [x] **Step 1: Write failing tests + fixture helper.** Append to `jxl_decode_roundtrip.rs`:

```rust
use raw_pipeline::jxl_sample::Sample;
use std::os::raw::c_void;
use std::ptr;
use jxl_ffi as ffi;

/// Test-only raw-FFI encoder: synthetic interleaved `S` pixels → JXL bytes.
/// Exists purely to mint decode fixtures for sample types casabio doesn't emit.
/// Delete once `jxl_encode.rs` lands and a shared round-trip harness replaces it.
unsafe fn encode_fixture<S: Sample>(px: &[S], w: u32, h: u32, channels: u32, alpha: bool) -> Vec<u8> {
    let enc = ffi::JxlEncoderCreate(ptr::null());
    let fs = ffi::JxlEncoderFrameSettingsCreate(enc, ptr::null());
    ffi::JxlEncoderSetFrameLossless(fs, 1); // lossless ⇒ exact round-trip for asserts

    let mut bi = std::mem::MaybeUninit::<ffi::JxlBasicInfo>::uninit();
    ffi::JxlEncoderInitBasicInfo(bi.as_mut_ptr());
    let mut bi = bi.assume_init();
    let (bits, exp) = S::bits_per_sample();
    bi.xsize = w; bi.ysize = h;
    bi.num_color_channels = if channels >= 3 { 3 } else { 1 };
    bi.bits_per_sample = bits; bi.exponent_bits_per_sample = exp;
    bi.uses_original_profile = 1;
    if alpha { bi.alpha_bits = bits; bi.alpha_exponent_bits = exp; bi.num_extra_channels = 1; }
    assert_eq!(ffi::JxlEncoderSetBasicInfo(enc, &bi), ffi::JxlEncoderStatus::JXL_ENC_SUCCESS);

    let mut color = std::mem::MaybeUninit::<ffi::JxlColorEncoding>::uninit();
    if exp > 0 { ffi::JxlColorEncodingSetToLinearSRGB(color.as_mut_ptr(), (bi.num_color_channels == 1) as i32); }
    else { ffi::JxlColorEncodingSetToSRGB(color.as_mut_ptr(), (bi.num_color_channels == 1) as i32); }
    let color = color.assume_init();
    ffi::JxlEncoderSetColorEncoding(enc, &color);

    let pf = ffi::JxlPixelFormat {
        num_channels: channels, data_type: S::data_type(),
        endianness: ffi::JxlEndianness::JXL_NATIVE_ENDIAN, align: 0,
    };
    assert_eq!(
        ffi::JxlEncoderAddImageFrame(fs, &pf, px.as_ptr() as *const c_void, std::mem::size_of_val(px)),
        ffi::JxlEncoderStatus::JXL_ENC_SUCCESS
    );
    ffi::JxlEncoderCloseInput(enc);

    let mut out = vec![0u8; 1 << 16];
    let mut used = 0usize;
    loop {
        let mut avail = out.len() - used;
        let mut next = out.as_mut_ptr().add(used);
        let st = ffi::JxlEncoderProcessOutput(enc, &mut next, &mut avail);
        used = out.len() - avail;
        if st == ffi::JxlEncoderStatus::JXL_ENC_NEED_MORE_OUTPUT { let n = out.len(); out.resize(n * 2, 0); }
        else { break; }
    }
    out.truncate(used);
    ffi::JxlEncoderDestroy(enc);
    out
}

#[test]
fn decode_u16_rgb_roundtrips_exact() {
    let (w, h) = (32u32, 24u32);
    let mut px = vec![0u16; (w * h * 3) as usize];
    for i in 0..px.len() { px[i] = (i as u16).wrapping_mul(257); }
    let jxl = unsafe { encode_fixture::<u16>(&px, w, h, 3, false) };

    let mut dec = Decoder::new(DecodeOptions::default()).unwrap();
    let img = dec.decode::<u16>(&jxl, Channels::Rgb).expect("u16 decode");
    assert_eq!((img.width, img.height, img.channels), (w, h, 3));
    assert_eq!(img.data, px, "lossless u16 must round-trip exactly");
}

#[test]
fn decode_f32_rgb_roundtrips_exact() {
    let (w, h) = (16u32, 16u32);
    let mut px = vec![0f32; (w * h * 3) as usize];
    for i in 0..px.len() { px[i] = (i as f32) / (px.len() as f32); }
    let jxl = unsafe { encode_fixture::<f32>(&px, w, h, 3, false) };

    let mut dec = Decoder::new(DecodeOptions::default()).unwrap();
    let img = dec.decode::<f32>(&jxl, Channels::Rgb).expect("f32 decode");
    assert_eq!((img.width, img.height), (w, h));
    for (a, b) in img.data.iter().zip(px.iter()) { assert!((a - b).abs() < 1e-4); }
}

#[test]
fn decode_f16_and_gray_paths() {
    let (w, h) = (16u32, 16u32);
    // f16 RGB
    let px16: Vec<half::f16> = (0..(w*h*3)).map(|i| half::f16::from_f32((i % 97) as f32 / 97.0)).collect();
    let jxl = unsafe { encode_fixture::<half::f16>(&px16, w, h, 3, false) };
    let mut dec = Decoder::new(DecodeOptions::default()).unwrap();
    let img = dec.decode::<half::f16>(&jxl, Channels::Rgb).expect("f16 decode");
    assert_eq!(img.data.len(), (w*h*3) as usize);
    // gray u8
    let g: Vec<u8> = (0..(w*h)).map(|i| (i % 256) as u8).collect();
    let jg = unsafe { encode_fixture::<u8>(&g, w, h, 1, false) };
    let ig = dec.decode::<u8>(&jg, Channels::Gray).expect("gray decode");
    assert_eq!((ig.width, ig.height, ig.channels), (w, h, 1));
    assert_eq!(ig.meta.num_color_channels, 1);
}
```

- [x] **Step 2: Run to verify it fails.**

Run: `.\build-msvc.ps1 test --manifest-path crates\raw-pipeline\Cargo.toml --no-default-features --features "jxl-decode" --test jxl_decode_roundtrip` (lean — these tests don't need jpegxl-rs)
Expected: FAIL to compile only if `ffi::JxlEncoder*` const names differ — adjust per P2. Otherwise the three new tests run.

- [x] **Step 3: Fix any binding-name mismatches** in the fixture helper (`JXL_ENC_SUCCESS`, `JXL_ENC_NEED_MORE_OUTPUT`, `alpha_exponent_bits`, `JxlColorEncodingSetToLinearSRGB`) against the dumped `bindings.rs`. No production code changes — `run_full::<S>` is already generic.

- [x] **Step 4: Run to verify it passes.**

Run: `.\build-msvc.ps1 test --manifest-path crates\raw-pipeline\Cargo.toml --no-default-features --features "jxl-decode" --test jxl_decode_roundtrip`
Expected: PASS — all four tests (u16, f32, f16+gray, plus Task 2's, though Task 2's needs `jxl-encode`; run the full-feature command to include it).

- [x] **Step 5: Commit.**

```bash
git add crates/raw-pipeline/tests/jxl_decode_roundtrip.rs
git commit -m "test(jxl-decode): u16/f16/f32 + gray generic-Sample round-trips via FFI fixture"
```

---

### Task 4: `decode_into` — buffer reuse (remove movement)

**Files:**
- Modify: `crates/raw-pipeline/src/jxl_decode.rs`
- Modify: `crates/raw-pipeline/tests/jxl_decode_roundtrip.rs`

- [x] **Step 1: Write the failing test.** Append:

```rust
#[test]
fn decode_into_reuses_buffer_capacity() {
    let (w, h) = (32u32, 32u32);
    let px: Vec<u8> = (0..(w*h*4)).map(|i| (i % 256) as u8).collect();
    let jxl = unsafe { encode_fixture::<u8>(&px, w, h, 4, true) };

    let mut dec = Decoder::new(DecodeOptions::default()).unwrap();
    let mut buf: Vec<u8> = Vec::new();
    let m1 = dec.decode_into::<u8>(&jxl, Channels::Rgba, &mut buf).expect("first");
    assert_eq!(buf.len(), (w*h*4) as usize);
    let cap = buf.capacity();
    let m2 = dec.decode_into::<u8>(&jxl, Channels::Rgba, &mut buf).expect("second");
    assert_eq!(buf.capacity(), cap, "equal-size redecode must not reallocate");
    assert_eq!((m1.num_color_channels, m2.num_color_channels), (3, 3));
}
```

- [x] **Step 2: Run to verify it fails.** Run the lean `--test jxl_decode_roundtrip` command. Expected: FAIL — `decode_into` not found.

- [x] **Step 3: Implement.** Refactor `run_full` to write into a caller buffer, and add `decode_into`. Replace the `data` allocation in `run_full` with a `&mut Vec<S>` parameter:

```rust
    /// Decode into a caller-owned buffer (reused across calls — no per-decode
    /// allocation on the hot path). Returns the discovered meta. The buffer ends
    /// at length `width*height*channels`.
    pub fn decode_into<S: Sample>(&mut self, jxl: &[u8], ch: Channels, buf: &mut Vec<S>) -> Option<DecodedMeta> {
        let out = unsafe { self.run_full_into::<S>(jxl, ch.count(), buf) };
        unsafe { ffi::JxlDecoderReset(self.handle); }
        out
    }
```

Rename `run_full` → `run_full_into` taking `buf: &mut Vec<S>`; inside the `NEED_OUT` arm replace the local `data` with:

```rust
                buf.clear();
                buf.reserve(elems);
                buf.set_len(elems);
                ptr::write_bytes(buf.as_mut_ptr(), 0, elems);
                if ffi::JxlDecoderSetImageOutBuffer(self.handle, &pf, buf.as_mut_ptr() as *mut c_void, size) != sym::SUCCESS {
                    return None;
                }
```

…return `Some(meta)` (and track `w,h` in fields the caller already has via meta? — keep `w,h` returned through a small private struct or stash on `self`). Simplest: have `run_full_into` return `Option<(u32,u32,DecodedMeta)>`; `decode_into` maps to `meta`; rewrite `decode` to call `run_full_into` with a fresh `Vec` and assemble `Image`:

```rust
    pub fn decode<S: Sample>(&mut self, jxl: &[u8], ch: Channels) -> Option<Image<S>> {
        let mut data: Vec<S> = Vec::new();
        let r = unsafe { self.run_full_into::<S>(jxl, ch.count(), &mut data) };
        unsafe { ffi::JxlDecoderReset(self.handle); }
        let (w, h, meta) = r?;
        Some(Image { width: w, height: h, channels: ch.count(), data, extra: Vec::new(), meta })
    }
```

- [x] **Step 4: Run to verify it passes.** Run the lean command. Expected: PASS (`decode_into_reuses_buffer_capacity` + unchanged Task 2/3 tests under full-feature).

- [x] **Step 5: Commit.**

```bash
git add crates/raw-pipeline/src/jxl_decode.rs crates/raw-pipeline/tests/jxl_decode_roundtrip.rs
git commit -m "feat(jxl-decode): decode_into buffer reuse (zero per-decode alloc)"
```

---

### Task 5: Planar extra-channel readback

**Files:**
- Modify: `crates/raw-pipeline/src/jxl_decode.rs`
- Modify: `crates/raw-pipeline/tests/jxl_decode_roundtrip.rs`

- [x] **Step 1: Write the failing test.** Append a test that mints a fixture with one non-alpha extra channel (extend `encode_fixture` inline or add `encode_fixture_extra`) and asserts `img.extra` comes back populated:

```rust
#[test]
fn decode_reads_back_one_planar_extra_channel() {
    let (w, h) = (16u32, 16u32);
    // color RGB + 1 extra (depth-like) plane, all u16, lossless.
    let color: Vec<u16> = (0..(w*h*3)).map(|i| (i as u16).wrapping_mul(7)).collect();
    let depth: Vec<u16> = (0..(w*h)).map(|i| (i as u16).wrapping_mul(11)).collect();
    let jxl = unsafe { encode_fixture_extra_u16(&color, &depth, w, h) };

    let mut dec = Decoder::new(DecodeOptions::default()).unwrap();
    let img = dec.decode::<u16>(&jxl, Channels::Rgb).expect("decode w/ extra");
    assert_eq!(img.meta.num_extra_channels, 1);
    assert_eq!(img.extra.len(), 1, "one planar extra channel read back");
    assert_eq!(img.extra[0].data.len(), (w*h) as usize);
    assert_eq!(img.extra[0].data, depth, "lossless extra plane round-trips");
}
```

Add the fixture (uses `JxlEncoderInitExtraChannelInfo` + `JxlEncoderSetExtraChannelInfo` + `JxlEncoderSetExtraChannelBuffer`, the encode mirror) in the test file.

- [x] **Step 2: Run to verify it fails.** Lean command. Expected: FAIL — `img.extra` empty (decoder doesn't read extra channels yet).

- [x] **Step 3: Implement extra readback in `run_full_into`.** After `BASIC_INFO` records `num_extra_channels`, allocate one `Vec<S>` per extra channel; in the `NEED_OUT` arm, after `SetImageOutBuffer`, size and bind each:

```rust
        // (fields above the loop)
        let mut extra: Vec<ExtraPlane<S>> = Vec::new();
        // (inside NEED_OUT, after SetImageOutBuffer)
        for idx in 0..meta.num_extra_channels {
            let mut esize = 0usize;
            if ffi::JxlDecoderExtraChannelBufferSize(self.handle, &pf, &mut esize, idx) != sym::SUCCESS { continue; }
            let n = esize / std::mem::size_of::<S>();
            let mut plane: Vec<S> = Vec::with_capacity(n);
            plane.set_len(n);
            ptr::write_bytes(plane.as_mut_ptr(), 0, n);
            if ffi::JxlDecoderSetExtraChannelBuffer(self.handle, &pf, plane.as_mut_ptr() as *mut c_void, esize, idx) == sym::SUCCESS {
                extra.push(ExtraPlane { index: idx, data: plane });
            }
        }
```

Return `extra` through `run_full_into` (extend its tuple to `(u32,u32,DecodedMeta,Vec<ExtraPlane<S>>)`); `decode` puts it in `Image.extra`; `decode_into` drops it (interleaved-only contract — document that `decode_into` ignores extra channels).

- [x] **Step 4: Run to verify it passes.** Lean command. Expected: PASS.

- [x] **Step 5: Commit.**

```bash
git add crates/raw-pipeline/src/jxl_decode.rs crates/raw-pipeline/tests/jxl_decode_roundtrip.rs
git commit -m "feat(jxl-decode): planar extra-channel readback (depth/thermal/spectral)"
```

---

### Task 6: Progressive decode (events + timings) + compat wrappers

**Files:**
- Modify: `crates/raw-pipeline/src/jxl_decode.rs`
- Test: reuse `crates/raw-pipeline/tests/jxl_lowlevel_progressive.rs` (Task 13 repoints it; here add a local test)

- [x] **Step 1: Write the failing test.** Append to `jxl_decode_roundtrip.rs`:

```rust
use raw_pipeline::jxl_decode::{decode_progressive_frames, DecodeProgressiveEvent, ProgressiveFrame};

#[test]
fn progressive_emits_final_with_full_shape() {
    let (w, h) = (256u32, 192u32);
    let rgba = gradient(w, h);
    let v = raw_pipeline::casabio_encode::encode_variants_with_progressive(
        &rgba, w, h, raw_pipeline::casabio_encode::SourceType::Raw, false, 2, 1).unwrap();

    let mut frames: Vec<ProgressiveFrame> = Vec::new();
    let timings = decode_progressive_frames(&v.full, |f| frames.push(f));
    assert!(timings.is_some());
    let last = frames.last().expect("final");
    assert!(last.is_final);
    assert_eq!((last.width, last.height), (w, h));
    assert_eq!(last.rgba.len(), (w*h*4) as usize);
}
```

(This test needs `jxl-encode` → run with the full-feature command.)

- [x] **Step 2: Run to verify it fails.** Full-feature `--test jxl_decode_roundtrip progressive`. Expected: FAIL — symbols absent.

- [x] **Step 3: Implement progressive.** Add to `jxl_decode.rs` — a generic event API plus the legacy RGBA8 compat wrappers (same names/sigs as `jxl_lowlevel.rs` so Task 13 is a path rename):

```rust
use std::time::Instant;

/// Borrowed (zero-copy) progressive event. `Progress` lends the live output
/// buffer; `Final` moves it out. Mirrors the legacy DecodeProgressiveEvent.
pub enum DecodeProgressiveEvent<'a> {
    Progress { width: u32, height: u32, rgba: &'a [u8] },
    Final { width: u32, height: u32, rgba: Vec<u8> },
}

#[derive(Clone, Debug)]
pub struct ProgressiveFrame { pub width: u32, pub height: u32, pub rgba: Vec<u8>, pub is_final: bool }

mod prog_sym {
    use jxl_ffi as ffi;
    // Verify exact name (P2): JxlProgressiveDetail::kPasses or _kPasses.
    pub const PASSES: ffi::JxlProgressiveDetail = ffi::JxlProgressiveDetail::kPasses;
}

/// RGBA8 progressive decode (borrowed events). Returns (first_pixel_ms, total_ms).
pub fn decode_progressive_frames_borrowed<F>(jxl: &[u8], mut on_frame: F) -> Option<(f64, f64)>
where F: FnMut(DecodeProgressiveEvent<'_>) {
    unsafe {
        let dec = ffi::JxlDecoderCreate(ptr::null());
        if dec.is_null() { return None; }
        let guard = scopeguard_destroy(dec); // see note
        let events = (sym::BASIC_INFO.0 | sym::FRAME_PROGRESSION.0 | sym::FULL_IMAGE.0) as c_int;
        if ffi::JxlDecoderSubscribeEvents(dec, events) != sym::SUCCESS { return None; }
        let _ = ffi::JxlDecoderSetProgressiveDetail(dec, prog_sym::PASSES);
        if ffi::JxlDecoderSetInput(dec, jxl.as_ptr(), jxl.len()) != sym::SUCCESS { return None; }
        ffi::JxlDecoderCloseInput(dec);

        let pf = pixel_format::<u8>(4);
        let mut info = std::mem::MaybeUninit::<ffi::JxlBasicInfo>::uninit();
        let (mut w, mut h) = (0u32, 0u32);
        let mut buf: Vec<u8> = Vec::new();
        let mut first: Option<f64> = None;
        let t0 = Instant::now();
        let ms = |i: Instant| i.elapsed().as_secs_f64() * 1000.0;
        let mut ok = false;
        loop {
            let st = ffi::JxlDecoderProcessInput(dec);
            if st == sym::BASIC_INFO {
                if w == 0 && ffi::JxlDecoderGetBasicInfo(dec, info.as_mut_ptr()) == sym::SUCCESS {
                    let bi = info.assume_init_ref(); w = bi.xsize; h = bi.ysize;
                }
            } else if st == sym::NEED_OUT {
                let mut size = 0usize;
                if ffi::JxlDecoderImageOutBufferSize(dec, &pf, &mut size) != sym::SUCCESS { return None; }
                buf.resize(size, 0);
                if ffi::JxlDecoderSetImageOutBuffer(dec, &pf, buf.as_mut_ptr() as *mut c_void, size) != sym::SUCCESS { return None; }
            } else if st == sym::FRAME_PROGRESSION {
                if ffi::JxlDecoderFlushImage(dec) == sym::SUCCESS && w > 0 && h > 0 {
                    if first.is_none() { first = Some(ms(t0)); }
                    on_frame(DecodeProgressiveEvent::Progress { width: w, height: h, rgba: &buf });
                }
            } else if st == sym::FULL_IMAGE || st == sym::SUCCESS { ok = true; break; }
            else { break; } // ERROR | NEED_MORE_INPUT
        }
        let total = ms(t0);
        drop(guard);
        if ok && !buf.is_empty() && w > 0 && h > 0 {
            on_frame(DecodeProgressiveEvent::Final { width: w, height: h, rgba: buf });
            Some((first.unwrap_or(0.0), total))
        } else { None }
    }
}

/// Owned-frame compat wrapper.
pub fn decode_progressive_frames<F>(jxl: &[u8], mut on_frame: F) -> Option<(f64, f64)>
where F: FnMut(ProgressiveFrame) {
    decode_progressive_frames_borrowed(jxl, |e| match e {
        DecodeProgressiveEvent::Progress { width, height, rgba } =>
            on_frame(ProgressiveFrame { width, height, rgba: rgba.to_vec(), is_final: false }),
        DecodeProgressiveEvent::Final { width, height, rgba } =>
            on_frame(ProgressiveFrame { width, height, rgba, is_final: true }),
    })
}

pub fn decode_progressive_first_total(jxl: &[u8]) -> Option<(f64, f64)> {
    decode_progressive_frames(jxl, |_| {})
}

/// Timing-only full decode (measurement path; no pixel retention). Compat for the bench.
pub fn decode_full(jxl: &[u8]) -> Option<std::time::Duration> {
    let t = Instant::now();
    decode_rgba8(jxl).map(|_| t.elapsed())
}

pub use decode_full as bench_jxl_decode_lowlevel_full;
pub use decode_progressive_first_total as bench_jxl_decode_lowlevel_progressive;
```

> **Note on `scopeguard_destroy`:** these standalone fns create a raw `*mut JxlDecoder` not owned by a `Decoder`, so destruction must happen on every return. Either (a) add the tiny `scopeguard`-style helper shown, or (b) restructure as `Decoder::decode_progressive::<S>(&mut self, …)` reusing the held handle + the `decode()` reset discipline (preferred — no manual guard). If choosing (b), make the free fns thin wrappers `Decoder::new(default)?.decode_progressive(...)`.

- [x] **Step 4: Run to verify it passes.** Full-feature `--test jxl_decode_roundtrip progressive`. Expected: PASS.

- [x] **Step 5: Commit.**

```bash
git add crates/raw-pipeline/src/jxl_decode.rs crates/raw-pipeline/tests/jxl_decode_roundtrip.rs
git commit -m "feat(jxl-decode): progressive FRAME_PROGRESSION events + RGBA8 compat wrappers"
```

---

### Task 7: Error-path reusability + `allow_partial`

**Files:**
- Modify: `crates/raw-pipeline/src/jxl_decode.rs`
- Modify: `crates/raw-pipeline/tests/jxl_decode_roundtrip.rs`

- [x] **Step 1: Write the failing test.**

```rust
#[test]
fn garbage_then_good_reuses_decoder() {
    let (w, h) = (32u32, 32u32);
    let px: Vec<u8> = (0..(w*h*4)).map(|i| (i % 256) as u8).collect();
    let good = unsafe { encode_fixture::<u8>(&px, w, h, 4, true) };

    let mut dec = Decoder::new(DecodeOptions::default()).unwrap();
    assert!(dec.decode::<u8>(b"not a jxl stream", Channels::Rgba).is_none(), "garbage → None");
    // The reset-on-every-path contract means the SAME decoder still works:
    let img = dec.decode::<u8>(&good, Channels::Rgba).expect("decoder reusable after error");
    assert_eq!((img.width, img.height), (w, h));
}
```

- [x] **Step 2: Run to verify it fails or passes.** Lean command. The reset-on-every-path design from Task 2 likely makes this **pass already** — if so, this task is a guard test (keep it; it locks the contract). If it fails, the reset is misplaced; move `JxlDecoderReset` to run unconditionally after `run_full_into` in `decode`.

- [x] **Step 3: Implement `allow_partial`** (only behaviour still missing). In the progressive/full loop, when `status` is `NEED_MORE_INPUT` and `self.opts.allow_partial` and a flushed buffer exists, return it instead of `None`. Add a `NEED_MORE_INPUT` alias to `mod sym` and branch on it.

- [x] **Step 4: Run to verify it passes.** Lean command. Expected: PASS.

- [x] **Step 5: Commit.**

```bash
git add crates/raw-pipeline/src/jxl_decode.rs crates/raw-pipeline/tests/jxl_decode_roundtrip.rs
git commit -m "test(jxl-decode): error-path reuse contract + allow_partial"
```

---

### Task 8: Parallel runner parity (MT == ST, byte-identical)

**Files:**
- Modify: `crates/raw-pipeline/tests/jxl_decode_roundtrip.rs`
- (Impl already in Task 2's `Decoder::new` + `attach_runner`; this proves determinism.)

- [x] **Step 1: Write the failing/guard test.**

```rust
#[test]
fn parallel_decode_is_byte_identical_to_serial() {
    let (w, h) = (160u32, 120u32);
    let rgba = gradient(w, h);
    let v = encode_variants(&rgba, w, h, SourceType::Jpeg, false).unwrap();

    let mut st = Decoder::new(DecodeOptions::default()).unwrap();
    let mut mt = Decoder::new(DecodeOptions { parallel: true, ..Default::default() }).unwrap();
    let a = st.decode::<u8>(&v.full, Channels::Rgba).unwrap();
    let b = mt.decode::<u8>(&v.full, Channels::Rgba).unwrap();
    assert_eq!(a.data, b.data, "libjxl MT decode must be deterministic ⇒ identical pixels");
}
```

- [x] **Step 2: Run to verify.** Full-feature command. Expected: PASS (proves the runner is wired and deterministic). If `JxlThreadParallelRunnerCreate` symbol-name differs, fix per P2.

- [x] **Step 3: (only if Step 2 fails)** correct the runner create/attach in `Decoder::new`/`attach_runner`.

- [x] **Step 4: Re-run.** Expected: PASS.

- [x] **Step 5: Commit.**

```bash
git add crates/raw-pipeline/tests/jxl_decode_roundtrip.rs
git commit -m "test(jxl-decode): parallel runner determinism (MT==ST)"
```

---

### Task 9: JXTC container path (`jxtc.rs`)

**Files:**
- Create: `crates/raw-pipeline/src/jxtc.rs`
- Test: `crates/raw-pipeline/tests/jxl_decode_roundtrip.rs`

- [x] **Step 1: Write the failing test** (header parse + overlap math — pure, no codec):

```rust
use raw_pipeline::jxtc::{parse_jxtc_header, overlapping_tile_indices, ImageRegion, JxtcHeader, JXTC_HEADER_BYTES};

#[test]
fn jxtc_header_and_overlap_math() {
    let mut buf = vec![0u8; JXTC_HEADER_BYTES];
    buf[0..4].copy_from_slice(&0x4354_584au32.to_le_bytes()); // 'JXTC'
    buf[4..8].copy_from_slice(&1u32.to_le_bytes());           // version
    buf[8..12].copy_from_slice(&512u32.to_le_bytes());        // image_w
    buf[12..16].copy_from_slice(&512u32.to_le_bytes());       // image_h
    buf[16..20].copy_from_slice(&256u32.to_le_bytes());       // tile_size
    buf[20..24].copy_from_slice(&2u32.to_le_bytes());         // tiles_x
    buf[24..28].copy_from_slice(&2u32.to_le_bytes());         // tiles_y
    let hdr = parse_jxtc_header(&buf).expect("parse");
    assert_eq!((hdr.tiles_x, hdr.tiles_y, hdr.tile_size), (2, 2, 256));
    let t = overlapping_tile_indices(&hdr, ImageRegion { x: 300, y: 10, w: 8, h: 8 });
    assert_eq!(t, vec![(1, 0)]);
}
```

- [x] **Step 2: Run to verify it fails.** Lean command. Expected: FAIL — `jxtc` module empty.

- [x] **Step 3: Implement `jxtc.rs`.** Move `parse_jxtc_header`, `overlapping_tile_indices`, `compute_tile_copy_rects`, `ImageRegion`, `JxtcHeader`, the `JXTC_*` consts **verbatim** from `jxl_lowlevel.rs` (they are already GPL-free — no `jpegxl_sys` usage). Re-point `decode_jxl_rgba16` + `decode_jxtc_region` at `Decoder`:

```rust
//! JXTC tile-container decode. Pure container math (moved verbatim from the
//! legacy jxl_lowlevel.rs) + per-tile decode re-pointed at jxl_decode::Decoder.
#![cfg(not(target_arch = "wasm32"))]

use rayon::prelude::*;
use crate::jxl_decode::{Decoder, DecodeOptions, Channels};

// ... (verbatim: ImageRegion, JxtcHeader, JXTC_* consts, parse_jxtc_header,
//      overlapping_tile_indices, compute_tile_copy_rects) ...

/// Decode one standalone per-tile RGBA16 JXL codestream → (pixels, w, h).
pub fn decode_jxl_rgba16(jxl: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    let mut dec = Decoder::new(DecodeOptions::default())?;
    let img = dec.decode::<u16>(jxl, Channels::Rgba)?;
    // u16 interleaved RGBA → bytes (native-endian) for the byte-oriented stitch.
    let bytes = bytemuck_cast_u16_to_u8(img.data); // or manual: see note
    Some((bytes, img.width, img.height))
}
```

> The legacy stitch works in **bytes** with `bpp = 8` for 16-bit. Keep that: convert the `Vec<u16>` to `Vec<u8>` via a small `to_ne_byte_vec` helper (no `bytemuck` dep needed — `u16::to_ne_bytes` per element, or `Vec::from_raw_parts` reinterpret since it's a copy out anyway). For RGBA8 tiles call `Decoder::decode::<u8>` and the data is already bytes. Port `decode_jxtc_region` body verbatim, swapping its inner `decode_jxl_rgba8/16` calls to the re-pointed ones; each rayon closure builds its **own** `Decoder` (owned-value semantics under rayon — matches the encoder spec).

> **YAGNI note:** `decode_jxtc_region` has no live caller today (it is the Tauri/native-ROI reference). It is ported to preserve the asset, not because anything consumes it yet. Mark it `#[allow(dead_code)]` if the build warns.

- [x] **Step 4: Run to verify it passes.** Lean command `--test jxl_decode_roundtrip jxtc`. Expected: PASS.

- [x] **Step 5: Commit.**

```bash
git add crates/raw-pipeline/src/jxtc.rs crates/raw-pipeline/tests/jxl_decode_roundtrip.rs
git commit -m "feat(jxl-decode): jxtc container path on Decoder (pure-math moved verbatim)"
```

---

### Task 10: Backend-swap byte-identity parity (temporary gate)

**Files:**
- Create: `crates/raw-pipeline/tests/jxl_decode_parity.rs`

This test runs **while both `jxl_decode` and `jxl_lowlevel` exist** and is deleted with `jxl_lowlevel.rs` in Task 14. It is the strongest correctness proof: same libjxl underneath ⇒ bit-identical.

- [x] **Step 1: Write the failing test.**

```rust
#![cfg(all(feature = "jxl-decode", feature = "jxl-lowlevel", feature = "jxl-encode", not(target_arch = "wasm32")))]

use raw_pipeline::casabio_encode::{encode_variants, SourceType};

fn gradient(w: u32, h: u32) -> Vec<u8> {
    (0..(w*h*4)).map(|i| (i & 0xFF) as u8).collect()
}

#[test]
fn new_decoder_byte_identical_to_legacy_lowlevel() {
    let (w, h) = (200u32, 150u32);
    let v = encode_variants(&gradient(w, h), w, h, SourceType::Jpeg, false).unwrap();

    let new = raw_pipeline::jxl_decode::decode_rgba8(&v.full).expect("new decode");
    let old = raw_pipeline::jxl_lowlevel::decode_jxl_rgba8(&v.full).expect("legacy decode");
    assert_eq!(new, old, "BSD decoder must be byte-identical to the GPL backend it replaces");
}
```

- [x] **Step 2: Run to verify.** Build with **both** features (this is the only test needing `jxl-lowlevel`):
  `.\build-msvc.ps1 test --manifest-path crates\raw-pipeline\Cargo.toml --no-default-features --features "jxl-decode,jxl-lowlevel,jxl-encode,parallel" --test jxl_decode_parity`
  Expected: PASS (byte-identical). A mismatch means a pixel-format/endianness bug in the new loop — fix before proceeding.

- [x] **Step 3: Add the `jxl-oxide` oracle test** to the same file (no `jxl-lowlevel` needed — gate that fn separately or keep the file's combined gate; simplest: a second file `jxl_decode_oracle.rs` gated `jxl-decode,jxl-encode`):

```rust
#[test]
fn new_decoder_agrees_with_jxl_oxide() {
    let (w, h) = (96u32, 96u32);
    let v = encode_variants(&gradient(w, h), w, h, SourceType::Jpeg, false).unwrap();
    let (ours, dw, dh) = raw_pipeline::jxl_decode::decode_rgba8(&v.full).unwrap();

    let img = jxl_oxide::JxlImage::builder().read(v.full.as_slice()).unwrap();
    let fb = img.render_frame(0).unwrap().image_all_channels();
    let (buf, ch) = (fb.buf(), fb.channels());
    assert_eq!((img.width(), img.height()), (dw, dh));
    let mut max_err = 0f32;
    for p in 0..(w*h) as usize { for c in 0..3 {
        let ours_lin = srgb_to_linear(ours[p*4 + c] as f32 / 255.0);
        max_err = max_err.max((buf[p*ch + c] - ours_lin).abs());
    }}
    assert!(max_err < 0.02, "oracle disagreement {max_err}");
}
// srgb_to_linear: copy the closure from tests/cross_encoder.rs:62-66
```

- [x] **Step 4: Run both.** Expected: PASS.

- [x] **Step 5: Commit.**

```bash
git add crates/raw-pipeline/tests/jxl_decode_parity.rs crates/raw-pipeline/tests/jxl_decode_oracle.rs
git commit -m "test(jxl-decode): byte-identity vs legacy backend + jxl-oxide oracle parity"
```

---

### Task 11: Rewire call sites (bench, casabio test, progressive test)

**Files:**
- Modify: `src/bin/raw_decode_bench.rs:44-48, 130-150, 712-734`
- Modify: `crates/raw-pipeline/src/casabio_encode.rs:813, 830`
- Modify: `crates/raw-pipeline/tests/jxl_lowlevel_progressive.rs:1-11`

- [x] **Step 1: Repoint the bench's lowlevel imports.** `raw_decode_bench.rs:44-48`: change the `#[cfg(feature = "jxl-lowlevel")]` to `#[cfg(feature = "jxl-decode")]` and the `use raw_pipeline::jxl_lowlevel::{…}` to `use raw_pipeline::jxl_decode::{ bench_jxl_decode_lowlevel_full, bench_jxl_decode_lowlevel_progressive };`. Flip the other two `#[cfg(feature = "jxl-lowlevel")]` gates (lines ~712, ~721) to `jxl-decode`.

- [x] **Step 2: Repoint the bench's high-level decode** (`bench_jxl_decode`, lines 130-150) off `jpegxl_rs::decode` onto the new MT decoder:

```rust
fn bench_jxl_decode(jxl_bytes: &[u8]) -> Option<Duration> {
    use raw_pipeline::jxl_decode::{Decoder, DecodeOptions, Channels};
    let mut best = Duration::MAX;
    for _ in 0..RUNS {
        let mut dec = Decoder::new(DecodeOptions { parallel: true, ..Default::default() })?;
        let t = Instant::now();
        let _ = dec.decode::<u8>(jxl_bytes, Channels::Rgba)?;
        let e = t.elapsed();
        if e < best { best = e; }
    }
    Some(best)
}
```

This requires the bench to build with `jxl-decode`. Update the run commands in the file's header doc comment and `main()`'s warning strings: `--features "jxl-lowlevel,..."` → `--features "jxl-decode,jxl-encode,parallel"`.

- [x] **Step 3: Repoint casabio test.** `casabio_encode.rs:813` `#[cfg(feature = "jxl-lowlevel")]` → `#[cfg(feature = "jxl-decode")]`; line 830 `crate::jxl_lowlevel::decode_jxl_rgba8` → `crate::jxl_decode::decode_jxl_rgba8` (signature identical — drop-in).

- [x] **Step 4: Repoint the progressive test.** `tests/jxl_lowlevel_progressive.rs:1-11`: change `feature = "jxl-lowlevel"` → `feature = "jxl-decode"` and `use raw_pipeline::jxl_lowlevel::{…}` → `use raw_pipeline::jxl_decode::{…}` (same item names).

- [x] **Step 5: Build + run all, then commit.**

Run: `.\build-msvc.ps1 test --manifest-path crates\raw-pipeline\Cargo.toml --no-default-features --features "jxl-decode,jxl-lowlevel,jxl-encode,parallel"` (both features so the parity test still runs)
Then bench builds: `.\build-msvc.ps1 build --bin raw_decode_bench --release --features "jxl-decode,jxl-encode,parallel"`
Expected: all green; bench compiles.

```bash
git add src/bin/raw_decode_bench.rs crates/raw-pipeline/src/casabio_encode.rs crates/raw-pipeline/tests/jxl_lowlevel_progressive.rs
git commit -m "refactor(jxl-decode): repoint bench + casabio + progressive test off GPL decode"
```

---

### Task 12: Drop `jpegxl-sys` + `jxl-lowlevel`; delete `jxl_lowlevel.rs`

**Files:**
- Modify: `crates/raw-pipeline/Cargo.toml:11-15, 29-30`
- Modify: `Cargo.toml` (root) `:17, 40-42`
- Modify: `crates/raw-pipeline/src/lib.rs:3-4`
- Delete: `crates/raw-pipeline/src/jxl_lowlevel.rs`
- Delete: `crates/raw-pipeline/tests/jxl_decode_parity.rs` (the temporary byte-identity gate — its job is done once the legacy backend is gone)

**Order (load-bearing): this task runs LAST, only after Tasks 1–11 are green.**

- [x] **Step 1: Delete the legacy module + its temporary parity gate.**

```bash
git rm crates/raw-pipeline/src/jxl_lowlevel.rs
git rm crates/raw-pipeline/tests/jxl_decode_parity.rs
```

- [x] **Step 2: Remove the module decl.** `crates/raw-pipeline/src/lib.rs`: delete lines 3-4 (`#[cfg(feature = "jxl-lowlevel")] pub mod jxl_lowlevel;`).

- [x] **Step 3: Drop the dep + feature.** In `crates/raw-pipeline/Cargo.toml`: delete the `jxl-lowlevel = [...]` feature line and the `jpegxl-sys = { ... optional = true }` line (lines ~15, ~30). In root `Cargo.toml`: delete the `jxl-lowlevel = ["raw-pipeline/jxl-lowlevel"]` forwarder (line 17) and the native `jpegxl-sys` dep (lines 40-42). Add the decode forwarder if not already present: `jxl-decode = ["raw-pipeline/jxl-decode"]`.

> Leave `jpegxl-rs` and `[patch.crates-io] jpegxl-src` — they belong to the **encoder** plan's Phase 4. This plan's licensing win: the decode code is BSD and the direct `jpegxl-sys` dependency is gone. (GPL persists transitively via `jpegxl-rs` until the encoder plan removes it; the two plans jointly finish the job.)

- [x] **Step 4: Refresh lock + full build/test.**

Run: `.\build-msvc.ps1 test --manifest-path crates\raw-pipeline\Cargo.toml --no-default-features --features "jxl-decode,jxl-encode,parallel"`
Then: `.\build-msvc.ps1 build --bin raw_decode_bench --release --features "jxl-decode,jxl-encode,parallel"`
Expected: green. No references to `jxl_lowlevel` or `jpegxl_sys` remain — verify:
`Grep` for `jxl_lowlevel|jpegxl_sys|jpegxl-sys|jxl-lowlevel` across `crates/raw-pipeline/src`, `src/bin`, both `Cargo.toml`s → only allowed hit is historical docs.

- [x] **Step 5: Commit.**

```bash
git add -A
git commit -m "chore(jxl-decode): drop jpegxl-sys + jxl-lowlevel; delete legacy GPL decoder"
```

---

## Final verification (run before declaring done)

- [x] **V1. Unit + round-trip + oracle green:**
  `.\build-msvc.ps1 test --manifest-path crates\raw-pipeline\Cargo.toml --no-default-features --features "jxl-decode,jxl-encode,parallel"`
- [x] **V2. Lean decode-only build green** (proves no accidental jpegxl-rs coupling in decode code):
  `.\build-msvc.ps1 build --manifest-path crates\raw-pipeline\Cargo.toml --no-default-features --features "jxl-decode"`
- [x] **V3. Bench runs + numbers sane:**
  `.\build-msvc.ps1 run --bin raw_decode_bench --release --features "jxl-decode,jxl-encode,parallel"` → `decodeMs` within tolerance of the pre-change `benchmark/results_native.json`.
- [x] **V4. No GPL decode symbols remain** (Grep, per Task 12 Step 4).
- [x] **V5. Success criteria** (spec §8) all checked, including: one `Decoder` reused across the JXTC tile fan-out; `u8/u16/f16/f32` + interleaved + planar-extra all tested; no `transmute`.

> **WASM unaffected:** this is a native-only change (`cfg(not(target_arch = "wasm32"))`). `StandardMultifileTest.mjs` and the `web/pkg` + `bridge.cpp` browser decode path are not touched and need not be re-run as a gate.

---

## Addendum — design-review §5a control & safety tasks

Folds in the adopted review items (spec §5a/§12). **Interleave** with the core
tasks as noted; the delete/drop-GPL ordering (Tasks 11–12) still runs **last**.
Each is TDD (failing test → impl → pass → commit) using the same build/test
commands above.

### Task A1: Typed `DecodeError` (Result API) — *do right after Task 2*

- Add the `DecodeError` enum (spec §5a). Change `Decoder::decode`/`decode_into`/`decode_view`/`decode_region` to return `Result<_, DecodeError>`. Keep compat free-fns returning `Option`/tuples by mapping `Err → None` (so Tasks 11 call sites stay path renames).
- Test: `dec.decode::<u8>(b"garbage", Channels::Rgba)` returns `Err(DecodeError::Process)`; a good image returns `Ok`. Replace Task 2/3's `.expect`/`is_none` assertions accordingly.
- Commit: `feat(jxl-decode): typed stage-located DecodeError`.

### Task A2: `DecodeLimits` bomb guard — *with A1*

- Add `DecodeLimits { max_pixels, max_output_bytes }` to `DecodeOptions` with a generous default. In `run_full_into`, after `BASIC_INFO`, compute `w*h*channels*size_of::<S>()` and return `Err(DecodeError::LimitExceeded{..})` **before** any large alloc.
- Test: craft/encode a small image, set `limits.max_pixels = 1`, assert `LimitExceeded` and that no buffer of image size was allocated (assert via the returned error path; optionally check `DecodeMetrics.allocations == 0`).
- Commit: `feat(jxl-decode): DecodeLimits decompression-bomb guard`.

### Task A3: `decode_view` borrowed analysis path — *after Task 4*

- Add `ImageView<'a,S>` + `Decoder::decode_view::<S,R>(jxl, ch, FnOnce(ImageView)->R) -> Result<R,DecodeError>`. Reuse `run_full_into` into an internal scratch `Vec<S>` the Decoder owns; lend `&scratch` to the closure; reset after. No owned `Image` constructed.
- Test: decode a known gradient via `decode_view`, compute a checksum inside the closure, assert it equals the checksum of `decode(...).data`; assert the closure's borrow doesn't outlive the call (compile-time — borrow checker).
- Commit: `feat(jxl-decode): decode_view borrowed analysis (no owned Vec)`.

### Task A4: Cancellation + progressive control — *after Task 6/7*

- Add `opts.cancel: Option<Arc<AtomicBool>>`, polled between `JxlDecoderProcessInput` steps in both loops → `Err(DecodeError::Cancelled)`. Change the progressive callback to return `ProgressControl`; `Stop` breaks and returns best-so-far. Add `pass: u32` to `Progress` events.
- Test: pre-set `cancel=true` → `decode` returns `Cancelled`, no image. Progressive callback returning `Stop` on first event → loop ends, fewer events than an uncontrolled run, still yields a usable final/partial.
- Commit: `feat(jxl-decode): cooperative cancellation + progressive Stop control`.

### Task A5: `decode_region` seam (full→crop v1) — *after Task 9*

- Add `DecodeRegion` + `Decoder::decode_region::<S>(jxl, ch, region)`: v1 decodes full then crops to the (clamped) rect, reusing `jxtc::compute_tile_copy_rects`-style row copies. Document the `JxlDecoderSetCropEnabled` v2 upgrade path.
- Test: decode a gradient region `(x,y,w,h)`, assert dims == clamped rect and the pixels equal the same rect sliced from a full decode.
- Commit: `feat(jxl-decode): decode_region seam (full→crop, libjxl-crop later)`.

### Task A6: `DecodeMetrics` + property tests — *fold into Final verification*

- `time_full_decode` returns `DecodeMetrics { input_bytes, output_bytes, allocations, decode_ms }`. Add property tests (spec §7): `decode(encode(x)) ≈ x` over `{u8,u16,f16,f32} × {64×48, 200×150}`; `parallel`==serial pixels; `LimitExceeded` allocates nothing large; pre-tripped `cancel` yields no image.
- Commit: `test(jxl-decode): DecodeMetrics + property suite (roundtrip/determinism/limit/cancel)`.

> **`read_color` / decode-to-linear** (spec §5a colour seam) is **deferred to the colour-management initiative** (spec §9), not built here — it changes nothing at default and has no current consumer (YAGNI). Listed for traceability only.

---

## Self-review notes (author)

- **Spec coverage:** every spec §2–§8 item maps to a task — ownership/reset (T2), zero-copy out (T2), generic Sample (T3), reuse buffer (T4), planar (T5), progressive/events (T6), reuse-after-error + allow_partial (T7), parallel runner (T8), JXTC (T9), parity gates (T10), migration/drop-GPL (T11–T12).
- **Binding-name risk** is isolated to `mod sym` / `mod prog_sym` and the fixture helper, all flagged against Precondition P2.
- **Type consistency:** `Decoder`, `DecodeOptions`, `Image<S>`, `DecodedMeta`, `ExtraPlane<S>`, `Channels`, `decode`/`decode_into`/`decode_rgba8`/`decode_jxl_rgba8` used identically across tasks.
- **Ordering** honours the spec's "build → repoint → drop → delete, never delete-first": deletion is Task 12, last.
- **Scope discipline:** `jpegxl-rs`/`vendor` teardown explicitly deferred to the encoder plan; JXTC region decode ported but flagged un-consumed (YAGNI on record).
