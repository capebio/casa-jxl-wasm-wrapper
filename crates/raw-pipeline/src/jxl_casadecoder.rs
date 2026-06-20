//! **JXL CasaDecoder** — BSD-clean native JPEG XL decoder on our own `jxl-ffi`
//! bindings to libjxl. Sister to `jxl_casaencoder.rs`; replaces the GPL
//! `jxl_lowlevel.rs` (which sat on `jpegxl-sys`).
//!
//! Strategic shape (design spec §2): **one owned [`Decoder`] holds the
//! `*JxlDecoder` handle. Feed it JXL bytes, get pixels back.** No hidden state,
//! explicit lifetime (RAII), reuse is visible (`JxlDecoderReset` between
//! decodes). Input is borrowed (zero-copy in); final pixels are written straight
//! into a typed `Vec<S>` (zero-copy out, no reinterpret pass). Generic over
//! [`Sample`] (`u8`/`u16`/`f16`/`f32`) and channel layout (interleaved + planar
//! extra).
//!
//! Correctness baked in (mirrors the encoder's review findings):
//! - **Reset on every exit path**, success *and* error — a reused [`Decoder`]
//!   can never be poisoned by a prior failure.
//! - **Typed events, no `transmute`** — status is the bindgen NewType
//!   `JxlDecoderStatus`; the loop `==`-compares typed associated consts.
//! - **Extra-channel readback is sized, never assumed** —
//!   `ExtraChannelBufferSize` before `SetExtraChannelBuffer`.
//! - **Decompression-bomb guard** — the pixel/byte budget is checked at
//!   `BASIC_INFO`, *before* any large output allocation.
//! - **Cooperative cancellation** — `opts.cancel` is polled between
//!   `JxlDecoderProcessInput` steps (honest between-steps granularity).
//! - `Send`, not `Sync` (libjxl context looked up per-use, not stored).
//!
//! `DecodeOptions::default()` reproduces the legacy `jxl_lowlevel.rs` behaviour
//! exactly — the parity contract. The `limits`/`cancel`/`keep_orientation`
//! knobs only *refuse* or *observe*; they never alter the pixels of a decode
//! that succeeds within budget.
//!
//! Native only (the WASM JXL path stays on `web/pkg` + `bridge.cpp`).

#![cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
// SpeedCodeReview ✓ 2026-06-20 · opus-4.8[1m] · sweeps=2 +peer-review · Arch 1/0/1 Alg 2/0/1 Code 4/4/0 (x/y/z=found/green/red, +1 deferred)

use std::os::raw::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rayon::prelude::*;

use jxl_ffi as ffi;

// The `Sample` trait + sample/pixel-format mapping are shared with the encoder
// (defined once in `jxl_casaencoder.rs`, per spec §6 — do not duplicate).
pub use crate::jxl_casaencoder::Sample;

// ── Typed status aliases (bindgen NewType assoc consts; no `transmute`) ───────
type St = ffi::JxlDecoderStatus;
const S_SUCCESS: St = ffi::JxlDecoderStatus::JXL_DEC_SUCCESS;
const S_BASIC: St = ffi::JxlDecoderStatus::JXL_DEC_BASIC_INFO;
const S_NEEDOUT: St = ffi::JxlDecoderStatus::JXL_DEC_NEED_IMAGE_OUT_BUFFER;
const S_FULL: St = ffi::JxlDecoderStatus::JXL_DEC_FULL_IMAGE;
const S_PROG: St = ffi::JxlDecoderStatus::JXL_DEC_FRAME_PROGRESSION;
const S_NEEDIN: St = ffi::JxlDecoderStatus::JXL_DEC_NEED_MORE_INPUT;

#[inline]
fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

/// Native-endian interleaved pixel format for `channels` channels of `S`.
#[inline]
fn pixel_format<S: Sample>(channels: u32) -> ffi::JxlPixelFormat {
    ffi::JxlPixelFormat {
        num_channels: channels,
        data_type: S::data_type(),
        endianness: ffi::JxlEndianness::JXL_NATIVE_ENDIAN,
        align: 0,
    }
}

// ── Public types ─────────────────────────────────────────────────────────────

/// Interleaved colour layout requested from the decoder.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Channels {
    Gray,
    GrayAlpha,
    Rgb,
    Rgba,
}

impl Channels {
    /// Interleaved channel count (1/2/3/4).
    pub fn count(self) -> u32 {
        match self {
            Channels::Gray => 1,
            Channels::GrayAlpha => 2,
            Channels::Rgb => 3,
            Channels::Rgba => 4,
        }
    }
}

/// Geometry/precision discovered from the bitstream (`JxlBasicInfo`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DecodedMeta {
    pub num_color_channels: u32,
    pub has_alpha: bool,
    /// Stream's stored precision (informational; output precision is `S`).
    pub bits_per_sample: u32,
    pub num_extra_channels: u32,
}

/// A planar extra channel read back from the stream (depth/thermal/spectral/
/// planar-alpha). `data` is `width * height` samples.
#[derive(Clone, Debug)]
pub struct ExtraPlane<S: Sample> {
    pub index: u32,
    pub data: Vec<S>,
}

/// Owned decoded image: interleaved colour `data` (+ optional planar `extra`).
#[derive(Clone, Debug)]
pub struct Image<S: Sample> {
    pub width: u32,
    pub height: u32,
    /// Interleaved channel count actually produced (1/2/3/4).
    pub channels: u32,
    /// Interleaved, `len == width * height * channels`.
    pub data: Vec<S>,
    pub extra: Vec<ExtraPlane<S>>,
    pub meta: DecodedMeta,
}

/// Borrowed analysis view (the measure-then-discard path). Lives only for the
/// `decode_view` closure scope — no owned `Vec` escapes, no copy across a
/// boundary. Ideal for SSIM/Butteraugli/stats (feed the `perceptual/*` kernels).
pub struct ImageView<'a, S: Sample> {
    pub width: u32,
    pub height: u32,
    pub channels: u32,
    pub data: &'a [S],
    pub extra: &'a [ExtraPlane<S>],
    pub meta: &'a DecodedMeta,
}

/// A rectangular viewport to decode (AR / digital-twin / tile seam).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DecodeRegion {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// Movement counters from the measurement path (validates "remove movement").
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct DecodeMetrics {
    pub input_bytes: u64,
    pub output_bytes: u64,
    pub allocations: u32,
    pub decode_ms: f64,
}

/// Resource budget — refuse decompression bombs *before* allocating output.
#[derive(Clone, Copy, Debug)]
pub struct DecodeLimits {
    pub max_pixels: u64,
    pub max_output_bytes: u64,
}

impl Default for DecodeLimits {
    /// Generous ceilings real images never hit (1 Gpx / 16 GiB) → default
    /// decode is never *altered*, only pathological headers are refused.
    fn default() -> Self {
        DecodeLimits {
            max_pixels: 1_000_000_000,
            max_output_bytes: 16 * 1024 * 1024 * 1024,
        }
    }
}

/// Decode-time knobs. `default()` reproduces the legacy `jxl_lowlevel.rs`
/// behaviour exactly (the parity contract).
#[derive(Clone, Debug, Default)]
pub struct DecodeOptions {
    /// Attach a scope-bound `JxlThreadParallelRunner` (default false = today's
    /// single-threaded behaviour). libjxl MT decode is bit-identical to ST.
    pub parallel: bool,
    /// Accept truncated input: return the best flushed image instead of failing.
    pub allow_partial: bool,
    /// `JxlDecoderSetKeepOrientation` (default false = libjxl applies EXIF
    /// orientation, today's behaviour).
    pub keep_orientation: bool,
    /// Resource budget (see [`DecodeLimits`]).
    pub limits: DecodeLimits,
    /// Cooperative cancellation, polled between libjxl steps.
    pub cancel: Option<Arc<AtomicBool>>,
}

/// Progressive flow control returned by the `decode_progressive` callback.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProgressControl {
    Continue,
    Stop,
}

/// Borrowed (zero-copy) progressive event for the generic object API. `Progress`
/// lends the live output buffer; quality is front-loaded so `pass` matters.
pub enum DecodeEvent<'a, S: Sample> {
    Progress {
        pass: u32,
        width: u32,
        height: u32,
        pixels: &'a [S],
    },
    Final {
        width: u32,
        height: u32,
        pixels: Vec<S>,
    },
}

/// Typed, stage-located decode failure (mirrors the encoder's `EncodeError`).
#[derive(thiserror::Error, Debug)]
pub enum DecodeError {
    #[error("JxlDecoderCreate returned null")]
    Create,
    #[error("JxlDecoderGetBasicInfo failed")]
    BasicInfo,
    #[error("output buffer allocation/binding failed")]
    OutputAlloc,
    #[error("libjxl decode process error")]
    Process,
    #[error("decode exceeds limits: {pixels} px / {bytes} bytes")]
    LimitExceeded { pixels: u64, bytes: u64 },
    #[error("decode cancelled")]
    Cancelled,
    #[error("tile {tile} decode failed: {source}")]
    Tile {
        tile: u32,
        source: Box<DecodeError>,
    },
}

// ── The Decoder object ───────────────────────────────────────────────────────

/// THE object. Owns the libjxl decoder handle (RAII; `Drop` destroys) and, only
/// when `opts.parallel`, a scope-bound `JxlThreadParallelRunner`. Reuse is
/// explicit: hold one `Decoder`, call `decode*` repeatedly — `JxlDecoderReset`
/// cleans state between decodes; no per-call create/destroy on the hot path.
pub struct Decoder {
    handle: *mut ffi::JxlDecoder,
    /// null unless `opts.parallel`.
    runner: *mut c_void,
    opts: DecodeOptions,
}

// libjxl context is looked up per-use, not stored → Send, not Sync.
unsafe impl Send for Decoder {}

impl Decoder {
    /// Construct a decoder. `JxlDecoderCreate` is a cheap malloc; the (costly)
    /// thread runner is created once here and held across decodes when
    /// `opts.parallel`.
    pub fn new(opts: DecodeOptions) -> Option<Self> {
        unsafe {
            let handle = ffi::JxlDecoderCreate(std::ptr::null());
            if handle.is_null() {
                return None;
            }
            let runner = if opts.parallel {
                let threads = std::thread::available_parallelism()
                    .map(|n| n.get())
                    .unwrap_or(4);
                ffi::JxlThreadParallelRunnerCreate(std::ptr::null(), threads)
            } else {
                std::ptr::null_mut()
            };
            // Reconcile opts.parallel with the actual runner state: if runner
            // creation failed (null), opts.parallel must reflect single-threaded
            // reality so attach_runner and callers are not misled.
            let mut opts = opts;
            opts.parallel = !runner.is_null();
            Some(Decoder {
                handle,
                runner,
                opts,
            })
        }
    }

    /// Replace the options used by subsequent decodes (the held handle is reused).
    ///
    /// **Note:** `opts.parallel` is reconciled with the live thread-runner state.
    /// The runner is created once in `Decoder::new`; `set_options` cannot start or
    /// stop it. If you pass `opts.parallel = true` but the runner was not created
    /// (because `parallel` was false at construction time), the flag is corrected
    /// to `false` so it accurately reflects actual behaviour.  Conversely, a
    /// runner created at construction is never torn down here — `opts.parallel`
    /// is forced to `true` when a runner is held.
    pub fn set_options(&mut self, mut opts: DecodeOptions) {
        // Force `parallel` to match the actual runner state so callers cannot
        // be misled by opts.parallel diverging from what attach_runner will do.
        opts.parallel = !self.runner.is_null();
        self.opts = opts;
    }

    #[inline]
    fn is_cancelled(&self) -> bool {
        self.opts
            .cancel
            .as_ref()
            // Acquire ensures the cancelling thread's stores are visible before we
            // observe the flag as set; Relaxed is insufficient for cross-thread visibility.
            .is_some_and(|c| c.load(Ordering::Acquire))
    }

    unsafe fn attach_runner(&self) -> Result<(), DecodeError> {
        if self.runner.is_null() {
            return Ok(());
        }
        if ffi::JxlDecoderSetParallelRunner(
            self.handle,
            Some(ffi::JxlThreadParallelRunner),
            self.runner,
        ) != S_SUCCESS
        {
            return Err(DecodeError::Process);
        }
        Ok(())
    }

    /// Decode the full image to interleaved `S` pixels (+ planar extra channels).
    /// Resets the handle on every exit path so the `Decoder` stays reusable.
    pub fn decode<S: Sample>(&mut self, jxl: &[u8], ch: Channels) -> Result<Image<S>, DecodeError> {
        let mut data: Vec<S> = Vec::new();
        let r = unsafe { self.run_full_into::<S>(jxl, ch.count(), &mut data, true) };
        unsafe { ffi::JxlDecoderReset(self.handle) };
        let (w, h, meta, extra) = r?;
        Ok(Image {
            width: w,
            height: h,
            channels: ch.count(),
            data,
            extra,
            meta,
        })
    }

    /// Decode into a caller-owned buffer reused across calls — **zero
    /// per-decode allocation** on the hot path (the "allocate once, reuse
    /// forever" win). Interleaved colour only; planar extra channels are not
    /// read back (use [`Decoder::decode`] for those). Returns discovered meta;
    /// `buf` ends at length `width * height * channels`.
    pub fn decode_into<S: Sample>(
        &mut self,
        jxl: &[u8],
        ch: Channels,
        buf: &mut Vec<S>,
    ) -> Result<DecodedMeta, DecodeError> {
        let r = unsafe { self.run_full_into::<S>(jxl, ch.count(), buf, false) };
        unsafe { ffi::JxlDecoderReset(self.handle) };
        let (_, _, meta, _) = r?;
        Ok(meta)
    }

    /// Decode, lend the buffer to `f`, then reset. No owned `Vec` escapes; no
    /// copy across a boundary — the correct home for measure-then-discard
    /// analysis (SSIM/Butteraugli/stats over the borrow).
    pub fn decode_view<S: Sample, R>(
        &mut self,
        jxl: &[u8],
        ch: Channels,
        f: impl FnOnce(ImageView<S>) -> R,
    ) -> Result<R, DecodeError> {
        let mut data: Vec<S> = Vec::new();
        let r = unsafe { self.run_full_into::<S>(jxl, ch.count(), &mut data, true) };
        let out = match r {
            Ok((w, h, meta, extra)) => {
                let view = ImageView {
                    width: w,
                    height: h,
                    channels: ch.count(),
                    data: &data,
                    extra: &extra,
                    meta: &meta,
                };
                Ok(f(view))
            }
            Err(e) => Err(e),
        };
        unsafe { ffi::JxlDecoderReset(self.handle) };
        out
    }

    /// Region decode (AR / digital-twin / tile seam). v1: decode-full-then-crop
    /// to the clamped rect, so call sites bind to the durable shape now; a
    /// future `JxlDecoderSetCropEnabled` v2 lands here without touching callers.
    pub fn decode_region<S: Sample>(
        &mut self,
        jxl: &[u8],
        ch: Channels,
        r: DecodeRegion,
    ) -> Result<Image<S>, DecodeError> {
        let full = self.decode::<S>(jxl, ch)?;
        let cc = ch.count() as usize;
        let x = r.x.min(full.width);
        let y = r.y.min(full.height);
        let w = r.width.min(full.width - x);
        let h = r.height.min(full.height - y);
        if w == 0 || h == 0 {
            return Ok(Image {
                width: 0,
                height: 0,
                channels: ch.count(),
                data: Vec::new(),
                extra: Vec::new(),
                meta: full.meta,
            });
        }
        let row = w as usize * cc;
        let mut data: Vec<S> = Vec::with_capacity(h as usize * row);
        for ry in 0..h {
            let src_off = ((y + ry) as usize * full.width as usize + x as usize) * cc;
            data.extend_from_slice(&full.data[src_off..src_off + row]);
        }
        // Crop extra planes (depth, spectral, thermal, etc.) to the same region.
        // Each extra plane is planar: width * height samples, one sample per pixel.
        let extra: Vec<ExtraPlane<S>> = full
            .extra
            .into_iter()
            .map(|plane| {
                let mut plane_data: Vec<S> = Vec::with_capacity(h as usize * w as usize);
                for ry in 0..h {
                    let src_off = (y + ry) as usize * full.width as usize + x as usize;
                    plane_data.extend_from_slice(&plane.data[src_off..src_off + w as usize]);
                }
                ExtraPlane { index: plane.index, data: plane_data }
            })
            .collect();
        Ok(Image {
            width: w,
            height: h,
            channels: ch.count(),
            data,
            extra,
            meta: full.meta,
        })
    }

    /// Progressive decode (`FRAME_PROGRESSION` + `FlushImage`). `on_event`
    /// receives borrowed `Progress` passes and may return [`ProgressControl::Stop`]
    /// to early-out (returns best-so-far). The final full image is the return
    /// value. Cooperative cancellation + limits apply.
    pub fn decode_progressive<S: Sample>(
        &mut self,
        jxl: &[u8],
        ch: Channels,
        mut on_event: impl FnMut(DecodeEvent<S>) -> ProgressControl,
    ) -> Result<Image<S>, DecodeError> {
        let r = unsafe { self.run_progressive_into::<S>(jxl, ch.count(), &mut on_event) };
        unsafe { ffi::JxlDecoderReset(self.handle) };
        r
    }

    /// Timing-only full decode (measurement path; pixels written to scratch and
    /// dropped). Returns movement counters.
    pub fn time_full_decode(&mut self, jxl: &[u8]) -> Result<DecodeMetrics, DecodeError> {
        let mut scratch: Vec<u8> = Vec::new();
        let t0 = Instant::now();
        // Always requests 4-channel (RGBA8) output regardless of actual channel count.
        // For grayscale JXL inputs this inflates measured output_bytes by 4× and
        // includes a channel-upsample overhead not present in real usage. The timing
        // is still a valid upper bound for photo (RGBA) decodes.
        let r = unsafe { self.run_full_into::<u8>(jxl, 4, &mut scratch, false) };
        let elapsed = t0.elapsed();
        unsafe { ffi::JxlDecoderReset(self.handle) };
        r?;
        Ok(DecodeMetrics {
            input_bytes: jxl.len() as u64,
            output_bytes: scratch.len() as u64, // u8 elems == bytes
            allocations: 1,
            decode_ms: ms(elapsed),
        })
    }

    /// Raw interleaved decode (no extra readback). Backs the compat free-fns.
    fn run_raw<S: Sample>(
        &mut self,
        jxl: &[u8],
        channels: u32,
    ) -> Result<(u32, u32, DecodedMeta, Vec<S>), DecodeError> {
        let mut data: Vec<S> = Vec::new();
        let r = unsafe { self.run_full_into::<S>(jxl, channels, &mut data, false) };
        unsafe { ffi::JxlDecoderReset(self.handle) };
        let (w, h, meta, _) = r?;
        Ok((w, h, meta, data))
    }

    /// Common one-shot decode driver. Writes final interleaved pixels straight
    /// into `buf` (zero-copy out). Caller resets the handle afterward.
    unsafe fn run_full_into<S: Sample>(
        &self,
        jxl: &[u8],
        channels: u32,
        buf: &mut Vec<S>,
        want_extra: bool,
    ) -> Result<(u32, u32, DecodedMeta, Vec<ExtraPlane<S>>), DecodeError> {
        let dec = self.handle;
        self.attach_runner()?;
        if self.opts.keep_orientation {
            ffi::JxlDecoderSetKeepOrientation(dec, 1);
        }
        // libjxl 0.11: JXL_DEC_NEED_IMAGE_OUT_BUFFER=5 is a sequential return
        // code (not a bit flag); JxlDecoderSubscribeEvents rejects values with
        // bits 0-5 set. NEEDOUT is returned automatically without subscription.
        let events = S_BASIC.0 | S_FULL.0;
        if ffi::JxlDecoderSubscribeEvents(dec, events) != S_SUCCESS {
            return Err(DecodeError::Process);
        }
        if ffi::JxlDecoderSetInput(dec, jxl.as_ptr(), jxl.len()) != S_SUCCESS {
            return Err(DecodeError::Process);
        }
        ffi::JxlDecoderCloseInput(dec);

        let pf = pixel_format::<S>(channels);
        let epf = pixel_format::<S>(1);
        let esz = std::mem::size_of::<S>();
        let mut info = std::mem::MaybeUninit::<ffi::JxlBasicInfo>::uninit();
        let mut meta = DecodedMeta::default();
        let (mut w, mut h) = (0u32, 0u32);
        let mut extra: Vec<ExtraPlane<S>> = Vec::new();

        loop {
            if self.is_cancelled() {
                return Err(DecodeError::Cancelled);
            }
            let status = ffi::JxlDecoderProcessInput(dec);
            if status == S_BASIC {
                if ffi::JxlDecoderGetBasicInfo(dec, info.as_mut_ptr()) != S_SUCCESS {
                    return Err(DecodeError::BasicInfo);
                }
                let bi = info.assume_init_ref();
                w = bi.xsize;
                h = bi.ysize;
                meta = DecodedMeta {
                    num_color_channels: bi.num_color_channels,
                    has_alpha: bi.alpha_bits > 0,
                    bits_per_sample: bi.bits_per_sample,
                    num_extra_channels: bi.num_extra_channels,
                };
                // Decompression-bomb guard: refuse BEFORE any large allocation.
                let pixels = w as u64 * h as u64;
                let out_bytes = pixels
                    .checked_mul(channels as u64)
                    .and_then(|n| n.checked_mul(esz as u64))
                    .ok_or(DecodeError::LimitExceeded {
                        pixels,
                        bytes: u64::MAX,
                    })?;
                if pixels > self.opts.limits.max_pixels
                    || out_bytes > self.opts.limits.max_output_bytes
                {
                    return Err(DecodeError::LimitExceeded {
                        pixels,
                        bytes: out_bytes,
                    });
                }
            } else if status == S_NEEDOUT {
                let mut size_bytes = 0usize;
                if ffi::JxlDecoderImageOutBufferSize(dec, &pf, &mut size_bytes) != S_SUCCESS {
                    return Err(DecodeError::OutputAlloc);
                }
                if size_bytes == 0 || size_bytes % esz != 0 {
                    return Err(DecodeError::OutputAlloc);
                }
                let elems = size_bytes / esz;
                // Zero-copy out: typed Vec<S>, libjxl writes straight into it.
                buf.clear();
                buf.reserve(elems);
                buf.set_len(elems);
                // Zero only for allow_partial: partial flushes expose uninitialised bytes
                // to the caller. On the normal (non-partial) path libjxl fills every byte
                // before returning S_FULL, so zeroing is unnecessary and wastes one full
                // memory sweep (~10-20 ms for 80 MB RGBA8 at 20 MP).
                if self.opts.allow_partial {
                    std::ptr::write_bytes(buf.as_mut_ptr(), 0, elems);
                }
                if ffi::JxlDecoderSetImageOutBuffer(
                    dec,
                    &pf,
                    buf.as_mut_ptr() as *mut c_void,
                    size_bytes,
                ) != S_SUCCESS
                {
                    return Err(DecodeError::OutputAlloc);
                }
                if want_extra {
                    for idx in 0..meta.num_extra_channels {
                        let mut ebytes = 0usize;
                        if ffi::JxlDecoderExtraChannelBufferSize(dec, &epf, &mut ebytes, idx)
                            != S_SUCCESS
                        {
                            continue;
                        }
                        if ebytes == 0 || ebytes % esz != 0 {
                            continue;
                        }
                        let n = ebytes / esz;
                        let mut plane: Vec<S> = Vec::with_capacity(n);
                        plane.set_len(n);
                        std::ptr::write_bytes(plane.as_mut_ptr(), 0, n);
                        if ffi::JxlDecoderSetExtraChannelBuffer(
                            dec,
                            &epf,
                            plane.as_mut_ptr() as *mut c_void,
                            ebytes,
                            idx,
                        ) == S_SUCCESS
                        {
                            extra.push(ExtraPlane { index: idx, data: plane });
                        }
                    }
                }
            } else if status == S_FULL || status == S_SUCCESS {
                break;
            } else if status == S_NEEDIN {
                // Truncated input. With allow_partial + a bound buffer, hand back
                // the best flush; otherwise it's a hard error.
                if self.opts.allow_partial && !buf.is_empty() && w > 0 && h > 0 {
                    let _ = ffi::JxlDecoderFlushImage(dec);
                    break;
                }
                return Err(DecodeError::Process);
            } else {
                // ERROR | unexpected.
                return Err(DecodeError::Process);
            }
        }
        if w == 0 || h == 0 || buf.is_empty() {
            return Err(DecodeError::Process);
        }
        Ok((w, h, meta, extra))
    }

    /// Progressive driver. Emits borrowed `Progress` passes via `on_event`;
    /// returns the final (or best-so-far on `Stop`/partial) image.
    unsafe fn run_progressive_into<S: Sample>(
        &self,
        jxl: &[u8],
        channels: u32,
        on_event: &mut impl FnMut(DecodeEvent<S>) -> ProgressControl,
    ) -> Result<Image<S>, DecodeError> {
        let dec = self.handle;
        self.attach_runner()?;
        if self.opts.keep_orientation {
            ffi::JxlDecoderSetKeepOrientation(dec, 1);
        }
        let events = S_BASIC.0 | S_PROG.0 | S_FULL.0;
        if ffi::JxlDecoderSubscribeEvents(dec, events) != S_SUCCESS {
            return Err(DecodeError::Process);
        }
        let _ = ffi::JxlDecoderSetProgressiveDetail(dec, ffi::JxlProgressiveDetail::kPasses);
        if ffi::JxlDecoderSetInput(dec, jxl.as_ptr(), jxl.len()) != S_SUCCESS {
            return Err(DecodeError::Process);
        }
        ffi::JxlDecoderCloseInput(dec);

        let pf = pixel_format::<S>(channels);
        let esz = std::mem::size_of::<S>();
        let mut info = std::mem::MaybeUninit::<ffi::JxlBasicInfo>::uninit();
        let mut meta = DecodedMeta::default();
        let (mut w, mut h) = (0u32, 0u32);
        let mut buf: Vec<S> = Vec::new();
        let mut pass = 0u32;

        loop {
            if self.is_cancelled() {
                return Err(DecodeError::Cancelled);
            }
            let status = ffi::JxlDecoderProcessInput(dec);
            if status == S_BASIC {
                if ffi::JxlDecoderGetBasicInfo(dec, info.as_mut_ptr()) != S_SUCCESS {
                    return Err(DecodeError::BasicInfo);
                }
                let bi = info.assume_init_ref();
                w = bi.xsize;
                h = bi.ysize;
                meta = DecodedMeta {
                    num_color_channels: bi.num_color_channels,
                    has_alpha: bi.alpha_bits > 0,
                    bits_per_sample: bi.bits_per_sample,
                    num_extra_channels: bi.num_extra_channels,
                };
                let pixels = w as u64 * h as u64;
                let out_bytes = pixels
                    .checked_mul(channels as u64)
                    .and_then(|n| n.checked_mul(esz as u64))
                    .ok_or(DecodeError::LimitExceeded {
                        pixels,
                        bytes: u64::MAX,
                    })?;
                if pixels > self.opts.limits.max_pixels
                    || out_bytes > self.opts.limits.max_output_bytes
                {
                    return Err(DecodeError::LimitExceeded {
                        pixels,
                        bytes: out_bytes,
                    });
                }
            } else if status == S_NEEDOUT {
                let mut size_bytes = 0usize;
                if ffi::JxlDecoderImageOutBufferSize(dec, &pf, &mut size_bytes) != S_SUCCESS {
                    return Err(DecodeError::OutputAlloc);
                }
                if size_bytes == 0 || size_bytes % esz != 0 {
                    return Err(DecodeError::OutputAlloc);
                }
                let elems = size_bytes / esz;
                buf.clear();
                buf.reserve(elems);
                buf.set_len(elems);
                // Progressive flushes expose partial buffers → always zero first.
                std::ptr::write_bytes(buf.as_mut_ptr(), 0, elems);
                if ffi::JxlDecoderSetImageOutBuffer(
                    dec,
                    &pf,
                    buf.as_mut_ptr() as *mut c_void,
                    size_bytes,
                ) != S_SUCCESS
                {
                    return Err(DecodeError::OutputAlloc);
                }
            } else if status == S_PROG {
                // Increment pass unconditionally so the counter stays in sync with
                // decoder-signalled progression events even when FlushImage fails.
                // The event carries the pre-increment value (pass before this flush).
                let this_pass = pass;
                pass += 1;
                if ffi::JxlDecoderFlushImage(dec) == S_SUCCESS && w > 0 && h > 0 {
                    let ctl = on_event(DecodeEvent::Progress {
                        pass: this_pass,
                        width: w,
                        height: h,
                        pixels: &buf,
                    });
                    if ctl == ProgressControl::Stop {
                        break;
                    }
                }
            } else if status == S_FULL || status == S_SUCCESS {
                break;
            } else if status == S_NEEDIN {
                if self.opts.allow_partial && !buf.is_empty() && w > 0 && h > 0 {
                    break;
                }
                return Err(DecodeError::Process);
            } else {
                return Err(DecodeError::Process);
            }
        }
        if w == 0 || h == 0 || buf.is_empty() {
            return Err(DecodeError::Process);
        }
        // The return value carries the definitive final image; callers that want
        // every progressive frame already received them via Progress events.
        // Emitting Final with a clone here would double peak memory (80 MB for 20 MP
        // RGBA8), so we omit it — the return value is the canonical final image.
        Ok(Image {
            width: w,
            height: h,
            channels,
            data: buf,
            extra: Vec::new(),
            meta,
        })
    }
}

impl Drop for Decoder {
    fn drop(&mut self) {
        unsafe {
            if !self.runner.is_null() {
                ffi::JxlThreadParallelRunnerDestroy(self.runner);
            }
            ffi::JxlDecoderDestroy(self.handle);
        }
    }
}

// ── Drop-in compat free fns — keep legacy call sites to path renames ──────────

/// Decode a JXL codestream to interleaved samples of type `S` with `channels`
/// interleaved channels (1 = gray, 3 = RGB, 4 = RGBA). `(pixels, width, height)`.
pub fn decode_interleaved<S: Sample>(jxl: &[u8], channels: u32) -> Option<(Vec<S>, u32, u32)> {
    let mut dec = Decoder::new(DecodeOptions::default())?;
    let (w, h, _, data) = dec.run_raw::<S>(jxl, channels).ok()?;
    Some((data, w, h))
}

/// Decode one standalone per-tile JXL codestream to RGBA8 bytes + dimensions.
/// Compat shape `(pixels, width, height)` matching the legacy
/// `jxl_lowlevel::decode_jxl_rgba8`.
pub fn decode_jxl_rgba8(jxl_bytes: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    decode_interleaved::<u8>(jxl_bytes, 4)
}

/// 16-bit (RGBA16) equivalent for JXTC-16 containers. Returns native-endian
/// `u16` packed as bytes (8 bytes/pixel), matching the prior `jpegxl-sys` path.
pub fn decode_jxl_rgba16(jxl_bytes: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    let (px, w, h) = decode_interleaved::<u16>(jxl_bytes, 4)?;
    Some((u16_samples_to_ne_bytes(&px), w, h))
}

/// Decode a JXL (full image) for timing. Returns the decode wall time.
pub fn decode_full(jxl_bytes: &[u8]) -> Option<Duration> {
    let mut dec = Decoder::new(DecodeOptions::default())?;
    dec.time_full_decode(jxl_bytes)
        .ok()
        .map(|m| Duration::from_secs_f64(m.decode_ms / 1000.0))
}

/// Threaded full decode for representative native benchmark numbers (runner
/// setup is excluded from timing, as before). Mirrors the prior `jpegxl-sys`
/// `ThreadsRunner` decode.
pub fn decode_full_threaded(jxl_bytes: &[u8], num_threads: usize) -> Option<Duration> {
    let mut dec = Decoder::new(DecodeOptions {
        parallel: num_threads > 1,
        ..Default::default()
    })?;
    dec.time_full_decode(jxl_bytes)
        .ok()
        .map(|m| Duration::from_secs_f64(m.decode_ms / 1000.0))
}

#[inline]
fn u16_samples_to_ne_bytes(px: &[u16]) -> Vec<u8> {
    // Cheap byte-for-byte copy into a fresh Vec<u8> (NOT zero-copy): the slice is
    // already native-endian in memory, so the bytes are copied verbatim. A true
    // in-place reinterpret (Vec<u16> -> Vec<u8>) is unsound — the allocator would
    // free a u8 layout that was allocated as u16 (size/align mismatch).
    // SAFETY: u16 has no padding/uninit bytes; u8 alignment is <= u16 alignment.
    let byte_len = px.len() * std::mem::size_of::<u16>();
    let mut bytes = Vec::with_capacity(byte_len);
    unsafe {
        std::ptr::copy_nonoverlapping(
            px.as_ptr() as *const u8,
            bytes.as_mut_ptr(),
            byte_len,
        );
        bytes.set_len(byte_len);
    }
    bytes
}

// ── progressive decode (legacy RGBA8 borrowed-event compat) ───────────────────

#[derive(Clone, Debug)]
pub struct ProgressiveFrame {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
    pub is_final: bool,
}

#[derive(Debug)]
pub enum DecodeProgressiveEvent<'a> {
    Progress { width: u32, height: u32, rgba: &'a [u8] },
    Final { width: u32, height: u32, rgba: Vec<u8> },
}

/// Progressive decode using FRAME_PROGRESSION + FlushImage. Invokes `on_frame`
/// after each successful flush (partial passes + final). Returns
/// `(time_to_first_usable_pixel_ms, total_wall_ms)`.
pub fn decode_progressive_frames_borrowed<F>(jxl_bytes: &[u8], mut on_frame: F) -> Option<(f64, f64)>
where
    F: FnMut(DecodeProgressiveEvent<'_>),
{
    unsafe {
        let dec = ffi::JxlDecoderCreate(std::ptr::null());
        if dec.is_null() {
            return None;
        }
        let events = S_BASIC.0 | S_PROG.0 | S_FULL.0;
        if ffi::JxlDecoderSubscribeEvents(dec, events) != S_SUCCESS {
            ffi::JxlDecoderDestroy(dec);
            return None;
        }
        let _ = ffi::JxlDecoderSetProgressiveDetail(dec, ffi::JxlProgressiveDetail::kPasses);
        if ffi::JxlDecoderSetInput(dec, jxl_bytes.as_ptr(), jxl_bytes.len()) != S_SUCCESS {
            ffi::JxlDecoderDestroy(dec);
            return None;
        }
        // Signal that all input bytes are available so libjxl does not stall
        // on JXL_DEC_NEED_MORE_INPUT even for a complete in-memory codestream.
        ffi::JxlDecoderCloseInput(dec);

        let pf = pixel_format::<u8>(4);
        let mut info = std::mem::MaybeUninit::<ffi::JxlBasicInfo>::uninit();
        let mut image_w = 0u32;
        let mut image_h = 0u32;
        let mut out_buf: Vec<u8> = Vec::new();
        let mut first_ms: Option<f64> = None;
        let t_start = Instant::now();
        let mut status;
        loop {
            status = ffi::JxlDecoderProcessInput(dec);
            if status == S_BASIC {
                if image_w == 0
                    && ffi::JxlDecoderGetBasicInfo(dec, info.as_mut_ptr()) == S_SUCCESS
                {
                    let bi = info.assume_init_ref();
                    // Decompression-bomb guard: reject before allocating output buffers.
                    // Use the same default limits as Decoder (1 Gpx / 16 GiB; see DecodeLimits::default).
                    let pixels = bi.xsize as u64 * bi.ysize as u64;
                    let out_bytes = pixels.saturating_mul(4);
                    if pixels > DecodeLimits::default().max_pixels
                        || out_bytes > DecodeLimits::default().max_output_bytes
                    {
                        status = ffi::JxlDecoderStatus::JXL_DEC_ERROR;
                        break;
                    }
                    image_w = bi.xsize;
                    image_h = bi.ysize;
                }
            } else if status == S_NEEDOUT {
                let mut size: usize = 0;
                if ffi::JxlDecoderImageOutBufferSize(dec, &pf, &mut size) == S_SUCCESS {
                    out_buf.resize(size, 0);
                    if ffi::JxlDecoderSetImageOutBuffer(
                        dec,
                        &pf,
                        out_buf.as_mut_ptr() as *mut _,
                        size,
                    ) != S_SUCCESS
                    {
                        status = ffi::JxlDecoderStatus::JXL_DEC_ERROR;
                        break;
                    }
                }
            } else if status == S_PROG {
                if ffi::JxlDecoderFlushImage(dec) == S_SUCCESS && image_w > 0 && image_h > 0 {
                    if first_ms.is_none() {
                        first_ms = Some(ms(t_start.elapsed()));
                    }
                    on_frame(DecodeProgressiveEvent::Progress {
                        width: image_w,
                        height: image_h,
                        rgba: &out_buf,
                    });
                }
            } else if status == S_FULL || status == S_SUCCESS {
                break;
            } else if status == ffi::JxlDecoderStatus::JXL_DEC_ERROR || status == S_NEEDIN {
                break;
            }
        }
        let total = t_start.elapsed();
        ffi::JxlDecoderDestroy(dec);
        if (status == S_FULL || status == S_SUCCESS)
            && !out_buf.is_empty()
            && image_w > 0
            && image_h > 0
        {
            on_frame(DecodeProgressiveEvent::Final {
                width: image_w,
                height: image_h,
                rgba: out_buf,
            });
            // When no progressive flush occurred (non-progressive codestream),
            // time-to-first-usable-pixel equals total decode time, not 0.
            Some((first_ms.unwrap_or_else(|| ms(total)), ms(total)))
        } else {
            None
        }
    }
}

/// Compatibility wrapper that clones progressive frames for retaining callers.
///
/// # Performance Warning
///
/// This function **clones the entire frame buffer on every progressive flush event**. For images
/// with dimensions such that RGBA8 output is 80+ MB, this incurs substantial allocation and copy
/// overhead per pass. Each intermediate flush clones the partial result.
///
/// # Better Alternative
///
/// For better performance, use [`decode_progressive_frames_borrowed`] with a callback that accepts
/// [`DecodeProgressiveEvent<'_>`]. This variant yields borrowed references (`&[u8]`) for intermediate
/// `Progress` events, eliminating the clone. Cloning is only needed if you must retain the data
/// beyond the callback scope.
///
/// Example:
/// ```ignore
/// decode_progressive_frames_borrowed(jxl_bytes, |event| match event {
///     DecodeProgressiveEvent::Progress { width, height, rgba } => {
///         // rgba is &[u8] — no clone needed if you're just reading it.
///         process_frame(width, height, rgba);
///     },
///     DecodeProgressiveEvent::Final { width, height, rgba } => {
///         // Only Final is owned (Vec<u8>) since it outlives the decoder.
///     },
/// })
/// ```
pub fn decode_progressive_frames<F>(jxl_bytes: &[u8], mut on_frame: F) -> Option<(f64, f64)>
where
    F: FnMut(ProgressiveFrame),
{
    decode_progressive_frames_borrowed(jxl_bytes, |event| match event {
        DecodeProgressiveEvent::Progress { width, height, rgba } => on_frame(ProgressiveFrame {
            width,
            height,
            rgba: rgba.to_vec(),
            is_final: false,
        }),
        DecodeProgressiveEvent::Final { width, height, rgba } => on_frame(ProgressiveFrame {
            width,
            height,
            rgba,
            is_final: true,
        }),
    })
}

/// Timing-only wrapper around [`decode_progressive_frames`].
pub fn decode_progressive_first_total(jxl_bytes: &[u8]) -> Option<(f64, f64)> {
    decode_progressive_frames(jxl_bytes, |_| {})
}

pub use decode_full as bench_jxl_decode_lowlevel_full;
pub use decode_progressive_first_total as bench_jxl_decode_lowlevel_progressive;

// ── per-tile JXTC ROI container (pure container math + Decoder-backed decode) ──

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ImageRegion {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

#[derive(Clone, Copy, Debug)]
pub struct JxtcHeader {
    pub image_w: u32,
    pub image_h: u32,
    pub tile_size: u32,
    pub tiles_x: u32,
    pub tiles_y: u32,
    pub has_alpha: bool,
    pub bits_per_sample: u8,
}

pub const JXTC_MAGIC: u32 = 0x4354_584a; // 'JXTC' little-endian
pub const JXTC_VERSION: u32 = 1;
pub const JXTC_HEADER_BYTES: usize = 32;
pub const JXTC_INDEX_ENTRY_BYTES: usize = 8;

/// Parse the 32-byte little-endian JXTC header (flags word at offset 28:
/// bit 0 = has_alpha, bit 1 = 16-bit).
pub fn parse_jxtc_header(data: &[u8]) -> Option<JxtcHeader> {
    if data.len() < JXTC_HEADER_BYTES {
        return None;
    }
    let magic = u32::from_le_bytes(data[0..4].try_into().ok()?);
    if magic != JXTC_MAGIC {
        return None;
    }
    let ver = u32::from_le_bytes(data[4..8].try_into().ok()?);
    if ver != JXTC_VERSION {
        return None;
    }
    let image_w = u32::from_le_bytes(data[8..12].try_into().ok()?);
    let image_h = u32::from_le_bytes(data[12..16].try_into().ok()?);
    let tile_size = u32::from_le_bytes(data[16..20].try_into().ok()?);
    let tiles_x = u32::from_le_bytes(data[20..24].try_into().ok()?);
    let tiles_y = u32::from_le_bytes(data[24..28].try_into().ok()?);
    let flags = u32::from_le_bytes(data[28..32].try_into().ok()?);

    if image_w == 0 || image_h == 0 || tile_size == 0 || tiles_x == 0 || tiles_y == 0 {
        return None;
    }

    // Validate that tiles_x / tiles_y exactly cover the image dimensions.
    // tiles_x > ceil(image_w/tile_size) would allow tx*tile_size > image_w in the
    // decode path, causing u32 underflow in expected-dimension calculations.
    // tiles_x < ceil would mean the last column of pixels is unreachable.
    let expected_tiles_x = image_w.div_ceil(tile_size);
    let expected_tiles_y = image_h.div_ceil(tile_size);
    if tiles_x != expected_tiles_x || tiles_y != expected_tiles_y {
        return None;
    }

    Some(JxtcHeader {
        image_w,
        image_h,
        tile_size,
        tiles_x,
        tiles_y,
        has_alpha: (flags & 1) != 0,
        bits_per_sample: if (flags & 2) != 0 { 16 } else { 8 },
    })
}

/// Grid coords (tile_x, tile_y) whose tiles overlap the (clamped) viewport.
pub fn overlapping_tile_indices(header: &JxtcHeader, region: ImageRegion) -> Vec<(u32, u32)> {
    let rx = region.x.min(header.image_w);
    let ry = region.y.min(header.image_h);
    let rw = region.w.min(header.image_w.saturating_sub(rx));
    let rh = region.h.min(header.image_h.saturating_sub(ry));

    if rw == 0 || rh == 0 {
        return vec![];
    }

    let tx_min = rx / header.tile_size;
    let tx_max = (rx + rw - 1) / header.tile_size;
    let ty_min = ry / header.tile_size;
    let ty_max = (ry + rh - 1) / header.tile_size;

    let mut out = Vec::new();
    for ty in ty_min..=ty_max {
        for tx in tx_min..=tx_max {
            if tx < header.tiles_x && ty < header.tiles_y {
                out.push((tx, ty));
            }
        }
    }
    out
}

fn compute_tile_copy_rects(
    header: &JxtcHeader,
    tx: u32,
    ty: u32,
    rx: u32,
    ry: u32,
    rw: u32,
    rh: u32,
    tile_w: u32,
    tile_h: u32,
) -> Option<(u32, u32, u32, u32, u32, u32)> {
    let tile_x0 = tx * header.tile_size;
    let tile_y0 = ty * header.tile_size;

    let ox0 = rx.max(tile_x0);
    let oy0 = ry.max(tile_y0);
    let ox1 = (rx + rw).min(tile_x0 + tile_w);
    let oy1 = (ry + rh).min(tile_y0 + tile_h);

    if ox1 <= ox0 || oy1 <= oy0 {
        return None;
    }

    let ow = ox1 - ox0;
    let oh = oy1 - oy0;

    let src_x = ox0 - tile_x0;
    let src_y = oy0 - tile_y0;
    let dst_x = ox0 - rx;
    let dst_y = oy0 - ry;

    Some((src_x, src_y, dst_x, dst_y, ow, oh))
}

/// Decode a rectangular viewport from a JXTC tile container. Each rayon worker
/// holds **one** [`Decoder`] reused across the tiles it handles (`map_init`) —
/// no per-tile create/destroy on the fan-out (spec §8 criterion 4).
pub fn decode_jxtc_region(
    container: &[u8],
    region_x: u32,
    region_y: u32,
    region_w: u32,
    region_h: u32,
) -> Option<Vec<u8>> {
    let header = parse_jxtc_header(container)?;

    let rx = region_x.min(header.image_w);
    let ry = region_y.min(header.image_h);
    let rw = region_w.min(header.image_w.saturating_sub(rx));
    let rh = region_h.min(header.image_h.saturating_sub(ry));

    if rw == 0 || rh == 0 {
        return Some(Vec::new());
    }

    let bpp = if header.bits_per_sample == 16 { 8usize } else { 4usize };

    // Checked arithmetic: tiles_x/tiles_y are attacker-controlled u32 header
    // fields. On 32-bit `tiles_x*tiles_y` and the index-table extent can
    // overflow `usize` and wrap below `container.len()`, passing the bounds test
    // and slicing arbitrary bytes. Reject any product/extent that overflows.
    let num_tiles = (header.tiles_x as usize).checked_mul(header.tiles_y as usize)?;
    let index_start = JXTC_HEADER_BYTES;
    let index_end = num_tiles
        .checked_mul(JXTC_INDEX_ENTRY_BYTES)
        .and_then(|table_bytes| index_start.checked_add(table_bytes))?;
    if container.len() < index_end {
        return None;
    }

    // The index table is validated present (container.len() >= index_end above);
    // each overlapping tile's 8-byte entry is read directly inside the fan-out
    // rather than materializing a Vec<(off,len)> for *all* num_tiles up front
    // (most are never touched for a small viewport).
    let overlapping = overlapping_tile_indices(&header, ImageRegion { x: rx, y: ry, w: rw, h: rh });

    let is16 = header.bits_per_sample == 16;
    let decoded_tiles: Vec<((u32, u32), Vec<u8>, u32, u32)> = overlapping
        .par_iter()
        .map_init(
            || Decoder::new(DecodeOptions::default()),
            |dec_slot, &(tx, ty)| {
                let dec = dec_slot.as_mut()?;
                // Cast to usize before multiplying to avoid u32 wrap (matches the
                // dest-copy convention below): ty*tiles_x is bounded by num_tiles,
                // which is a usize-checked product — the intermediate must widen too.
                let idx = ty as usize * header.tiles_x as usize + tx as usize;
                // Read this tile's index entry directly from the validated table.
                // overlapping_tile_indices guarantees tx<tiles_x && ty<tiles_y, so
                // idx<num_tiles ⇒ base+8 <= index_end <= container.len(); the
                // explicit guard keeps the None-on-OOB contract (no panic) regardless.
                let base = index_start + idx * JXTC_INDEX_ENTRY_BYTES;
                if base + JXTC_INDEX_ENTRY_BYTES > index_end {
                    return None;
                }
                let off = u32::from_le_bytes(container[base..base + 4].try_into().ok()?);
                let len = u32::from_le_bytes(container[base + 4..base + 8].try_into().ok()?);
                let start = off as usize;
                // Checked add: on 32-bit `start + len` can wrap below
                // container.len() and slip past the bounds test.
                let end = start.checked_add(len as usize)?;
                if end > container.len() {
                    return None;
                }
                // Trust-boundary: tiles must not overlap the header or index table.
                // A crafted container with off < index_end would feed index bytes to
                // the JXL decoder, potentially bypassing format validation.
                if start < index_end {
                    return None;
                }
                let tile_jxl = &container[start..end];

                let (pixels, tw, th) = if is16 {
                    let img = dec.decode::<u16>(tile_jxl, Channels::Rgba).ok()?;
                    (u16_samples_to_ne_bytes(&img.data), img.width, img.height)
                } else {
                    let img = dec.decode::<u8>(tile_jxl, Channels::Rgba).ok()?;
                    (img.data, img.width, img.height)
                };

                // saturating_sub: malformed headers can have tiles_x > ceil(image_w/tile_size);
                // without saturation the subtraction wraps on u32 targets (see also parse validation).
                let exp_w = header.tile_size.min(header.image_w.saturating_sub(tx * header.tile_size));
                let exp_h = header.tile_size.min(header.image_h.saturating_sub(ty * header.tile_size));
                if tw != exp_w || th != exp_h {
                    return None;
                }
                Some(((tx, ty), pixels, tw, th))
            },
        )
        .collect::<Vec<Option<_>>>()
        .into_iter()
        .flatten()
        .collect();

    // Checked multiply: rw*rh*bpp can overflow on 32-bit/WASM targets.
    let dest_len = (rw as usize)
        .checked_mul(rh as usize)
        .and_then(|n| n.checked_mul(bpp))?;
    let mut dest = vec![0u8; dest_len];

    for ((tx, ty), tile_pixels, tw, th) in decoded_tiles {
        // Trust-boundary guard: `tw`/`th` are decoder-reported dims; verify the
        // buffer actually holds tw*th*bpp bytes so a mismatch skips the tile
        // instead of OOB-panicking copy_from_slice.
        let needed = (tw as usize)
            .checked_mul(th as usize)
            .and_then(|px| px.checked_mul(bpp));
        match needed {
            Some(n) if tile_pixels.len() >= n => {}
            _ => continue,
        }
        if let Some((src_x, src_y, dst_x, dst_y, ow, oh)) =
            compute_tile_copy_rects(&header, tx, ty, rx, ry, rw, rh, tw, th)
        {
            for row in 0..oh {
                // Cast to usize before multiplying to avoid u32 wrap on 32-bit (WASM).
                let src_row_off = ((src_y + row) as usize * tw as usize + src_x as usize) * bpp;
                let dst_row_off = ((dst_y + row) as usize * rw as usize + dst_x as usize) * bpp;
                let row_bytes = (ow as usize) * bpp;

                dest[dst_row_off..dst_row_off + row_bytes]
                    .copy_from_slice(&tile_pixels[src_row_off..src_row_off + row_bytes]);
            }
        }
    }

    Some(dest)
}

pub use overlapping_tile_indices as jxtc_overlapping_tile_indices;
pub use parse_jxtc_header as jxtc_parse_header;

// ── tests ─────────────────────────────────────────────────────────────────────
// Fixtures are minted with the sister BSD encoder (`jxl_casaencoder`) in **lossless**
// mode, so every round-trip assert is bit-exact. `half` is a crate dependency
// (jxl-codec), so f16 is exercised here without a dev-dependency.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::jxl_casaencoder::{EncodeOptions, Encoder, ExtraChannel, ExtraKind, Frame};

    fn enc_lossless<S: Sample>(frame: &Frame<S>) -> Vec<u8> {
        let mut enc = Encoder::new(EncodeOptions::lossless()).expect("encoder");
        enc.encode(frame).expect("encode")
    }

    fn gradient_rgba8(w: u32, h: u32) -> Vec<u8> {
        let mut v = vec![0u8; (w * h * 4) as usize];
        for y in 0..h {
            for x in 0..w {
                let i = ((y * w + x) * 4) as usize;
                v[i] = (x % 256) as u8;
                v[i + 1] = (y % 256) as u8;
                v[i + 2] = ((x + y) % 256) as u8;
                v[i + 3] = 255;
            }
        }
        v
    }

    #[test]
    fn decode_rgba8_recovers_dims_and_pixels() {
        let (w, h) = (64u32, 48u32);
        let rgba = gradient_rgba8(w, h);
        let jxl = enc_lossless(&Frame::rgba8(&rgba, w, h));

        let (px, dw, dh) = decode_jxl_rgba8(&jxl).expect("free-fn decode");
        assert_eq!((dw, dh), (w, h));
        assert_eq!(px, rgba, "lossless RGBA8 must round-trip exactly");

        let mut dec = Decoder::new(DecodeOptions::default()).unwrap();
        let img: Image<u8> = dec.decode(&jxl, Channels::Rgba).unwrap();
        assert_eq!((img.width, img.height, img.channels), (w, h, 4));
        assert_eq!(img.data, px);
        assert!(img.meta.num_color_channels >= 3);
    }

    #[test]
    fn decode_u16_rgb_roundtrips_exact() {
        let (w, h) = (32u32, 24u32);
        let px: Vec<u16> = (0..(w * h * 3)).map(|i| (i as u16).wrapping_mul(257)).collect();
        let jxl = enc_lossless(&Frame::rgb(&px, w, h));
        let mut dec = Decoder::new(DecodeOptions::default()).unwrap();
        let img = dec.decode::<u16>(&jxl, Channels::Rgb).unwrap();
        assert_eq!((img.width, img.height, img.channels), (w, h, 3));
        assert_eq!(img.data, px, "lossless u16 exact");
    }

    #[test]
    fn decode_f32_rgb_roundtrips() {
        let (w, h) = (16u32, 16u32);
        let n = (w * h * 3) as usize;
        let px: Vec<f32> = (0..n).map(|i| i as f32 / n as f32).collect();
        let jxl = enc_lossless(&Frame::rgb(&px, w, h));
        let mut dec = Decoder::new(DecodeOptions::default()).unwrap();
        let img = dec.decode::<f32>(&jxl, Channels::Rgb).unwrap();
        assert_eq!((img.width, img.height), (w, h));
        for (a, b) in img.data.iter().zip(px.iter()) {
            assert!((a - b).abs() < 1e-4, "{a} vs {b}");
        }
    }

    #[test]
    fn decode_f16_and_gray() {
        let (w, h) = (16u32, 16u32);
        let px16: Vec<half::f16> = (0..(w * h * 3))
            .map(|i| half::f16::from_f32((i % 97) as f32 / 97.0))
            .collect();
        let jxl = enc_lossless(&Frame::rgb(&px16, w, h));
        let mut dec = Decoder::new(DecodeOptions::default()).unwrap();
        let img = dec.decode::<half::f16>(&jxl, Channels::Rgb).unwrap();
        assert_eq!(img.data.len(), (w * h * 3) as usize);

        let g: Vec<u8> = (0..(w * h)).map(|i| (i % 256) as u8).collect();
        let jg = enc_lossless(&Frame::gray(&g, w, h));
        let ig = dec.decode::<u8>(&jg, Channels::Gray).unwrap();
        assert_eq!((ig.width, ig.height, ig.channels), (w, h, 1));
        assert_eq!(ig.meta.num_color_channels, 1);
        assert_eq!(ig.data, g, "lossless gray exact");
    }

    #[test]
    fn decode_into_reuses_buffer_capacity() {
        let (w, h) = (32u32, 32u32);
        let rgba = gradient_rgba8(w, h);
        let jxl = enc_lossless(&Frame::rgba8(&rgba, w, h));
        let mut dec = Decoder::new(DecodeOptions::default()).unwrap();
        let mut buf: Vec<u8> = Vec::new();
        let m1 = dec.decode_into::<u8>(&jxl, Channels::Rgba, &mut buf).unwrap();
        assert_eq!(buf.len(), (w * h * 4) as usize);
        assert_eq!(buf, rgba);
        let cap = buf.capacity();
        let _ = dec.decode_into::<u8>(&jxl, Channels::Rgba, &mut buf).unwrap();
        assert_eq!(buf.capacity(), cap, "equal-size redecode must not reallocate");
        assert!(m1.num_color_channels >= 3);
    }

    #[test]
    fn decode_view_matches_owned() {
        let (w, h) = (40u32, 30u32);
        let rgba = gradient_rgba8(w, h);
        let jxl = enc_lossless(&Frame::rgba8(&rgba, w, h));
        let mut dec = Decoder::new(DecodeOptions::default()).unwrap();
        let sum_view = dec
            .decode_view::<u8, _>(&jxl, Channels::Rgba, |v| {
                assert_eq!((v.width, v.height, v.channels), (w, h, 4));
                v.data.iter().map(|&b| b as u64).sum::<u64>()
            })
            .unwrap();
        let img = dec.decode::<u8>(&jxl, Channels::Rgba).unwrap();
        let sum_owned: u64 = img.data.iter().map(|&b| b as u64).sum();
        assert_eq!(sum_view, sum_owned);
    }

    #[test]
    fn decode_region_equals_full_crop() {
        let (w, h) = (64u32, 64u32);
        let rgba = gradient_rgba8(w, h);
        let jxl = enc_lossless(&Frame::rgba8(&rgba, w, h));
        let mut dec = Decoder::new(DecodeOptions::default()).unwrap();
        let full = dec.decode::<u8>(&jxl, Channels::Rgba).unwrap();
        let r = DecodeRegion { x: 10, y: 8, width: 20, height: 16 };
        let reg = dec.decode_region::<u8>(&jxl, Channels::Rgba, r).unwrap();
        assert_eq!((reg.width, reg.height), (20, 16));
        for ry in 0..16u32 {
            for rx in 0..20u32 {
                let s = (((r.y + ry) * w + (r.x + rx)) * 4) as usize;
                let d = ((ry * 20 + rx) * 4) as usize;
                assert_eq!(&reg.data[d..d + 4], &full.data[s..s + 4]);
            }
        }
    }

    #[test]
    fn garbage_then_good_reuses_decoder() {
        let (w, h) = (32u32, 32u32);
        let rgba = gradient_rgba8(w, h);
        let good = enc_lossless(&Frame::rgba8(&rgba, w, h));
        let mut dec = Decoder::new(DecodeOptions::default()).unwrap();
        let bad = dec.decode::<u8>(b"not a jxl stream at all", Channels::Rgba);
        assert!(matches!(bad, Err(DecodeError::Process)), "garbage → Process");
        // reset-on-every-path ⇒ the SAME decoder still works.
        let img = dec.decode::<u8>(&good, Channels::Rgba).expect("reusable after error");
        assert_eq!((img.width, img.height), (w, h));
    }

    #[test]
    fn limits_refuse_decompression_bomb() {
        let (w, h) = (32u32, 32u32);
        let rgba = gradient_rgba8(w, h);
        let jxl = enc_lossless(&Frame::rgba8(&rgba, w, h));
        let mut dec = Decoder::new(DecodeOptions {
            limits: DecodeLimits { max_pixels: 1, max_output_bytes: u64::MAX },
            ..Default::default()
        })
        .unwrap();
        assert!(matches!(
            dec.decode::<u8>(&jxl, Channels::Rgba),
            Err(DecodeError::LimitExceeded { .. })
        ));
        // refusal leaves the decoder usable.
        dec.set_options(DecodeOptions::default());
        assert!(dec.decode::<u8>(&jxl, Channels::Rgba).is_ok());
    }

    #[test]
    fn pretripped_cancel_yields_no_image() {
        let (w, h) = (32u32, 32u32);
        let rgba = gradient_rgba8(w, h);
        let jxl = enc_lossless(&Frame::rgba8(&rgba, w, h));
        let flag = Arc::new(AtomicBool::new(true));
        let mut dec = Decoder::new(DecodeOptions {
            cancel: Some(flag.clone()),
            ..Default::default()
        })
        .unwrap();
        assert!(matches!(
            dec.decode::<u8>(&jxl, Channels::Rgba),
            Err(DecodeError::Cancelled)
        ));
        flag.store(false, Ordering::Relaxed);
        assert!(dec.decode::<u8>(&jxl, Channels::Rgba).is_ok());
    }

    #[test]
    fn reads_back_one_planar_extra_channel() {
        let (w, h) = (16u32, 16u32);
        let color: Vec<u16> = (0..(w * h * 3)).map(|i| (i as u16).wrapping_mul(7)).collect();
        let depth: Vec<u16> = (0..(w * h)).map(|i| (i as u16).wrapping_mul(11)).collect();
        let extras = [ExtraChannel { kind: ExtraKind::Depth, data: &depth }];
        let mut frame = Frame::rgb(&color, w, h);
        frame.extra = &extras;
        let jxl = enc_lossless(&frame);

        let mut dec = Decoder::new(DecodeOptions::default()).unwrap();
        let img = dec.decode::<u16>(&jxl, Channels::Rgb).unwrap();
        assert_eq!(img.meta.num_extra_channels, 1);
        assert_eq!(img.extra.len(), 1, "one planar extra read back");
        assert_eq!(img.extra[0].data.len(), (w * h) as usize);
        assert_eq!(img.extra[0].data, depth, "lossless extra plane exact");
    }

    #[test]
    fn parallel_decode_byte_identical_to_serial() {
        let (w, h) = (80u32, 60u32);
        let rgba = gradient_rgba8(w, h);
        let jxl = enc_lossless(&Frame::rgba8(&rgba, w, h));
        let mut st = Decoder::new(DecodeOptions::default()).unwrap();
        let mut mt = Decoder::new(DecodeOptions { parallel: true, ..Default::default() }).unwrap();
        let a = st.decode::<u8>(&jxl, Channels::Rgba).unwrap();
        let b = mt.decode::<u8>(&jxl, Channels::Rgba).unwrap();
        assert_eq!(a.data, b.data, "libjxl MT decode is deterministic ⇒ identical pixels");
    }

    #[test]
    fn time_full_decode_reports_metrics() {
        let (w, h) = (48u32, 36u32);
        let rgba = gradient_rgba8(w, h);
        let jxl = enc_lossless(&Frame::rgba8(&rgba, w, h));
        let mut dec = Decoder::new(DecodeOptions::default()).unwrap();
        let m = dec.time_full_decode(&jxl).unwrap();
        assert!(m.input_bytes > 0);
        assert_eq!(m.output_bytes, (w * h * 4) as u64);
        assert!(m.decode_ms >= 0.0);
    }

    #[test]
    fn decode_progressive_object_returns_full_image() {
        let (w, h) = (256u32, 192u32);
        let rgba = gradient_rgba8(w, h);
        let variants = crate::casabio_encode::encode_variants_with_progressive(
            &rgba,
            w,
            h,
            crate::casabio_encode::SourceType::Raw,
            false,
            2,
            1,
        )
        .expect("progressive encode");

        let mut dec = Decoder::new(DecodeOptions::default()).unwrap();
        let mut passes = 0u32;
        let img = dec
            .decode_progressive::<u8>(&variants.full, Channels::Rgba, |ev| {
                if let DecodeEvent::Progress { width, height, .. } = ev {
                    assert_eq!((width, height), (w, h));
                    passes += 1;
                }
                ProgressControl::Continue
            })
            .unwrap();
        assert_eq!((img.width, img.height), (w, h));
        assert_eq!(img.data.len(), (w * h * 4) as usize);
        let _ = passes;
    }

    #[test]
    fn decode_progressive_stop_returns_best_so_far() {
        let (w, h) = (256u32, 192u32);
        let rgba = gradient_rgba8(w, h);
        let variants = crate::casabio_encode::encode_variants_with_progressive(
            &rgba,
            w,
            h,
            crate::casabio_encode::SourceType::Raw,
            false,
            2,
            1,
        )
        .expect("progressive encode");

        let mut dec = Decoder::new(DecodeOptions::default()).unwrap();
        let img = dec
            .decode_progressive::<u8>(&variants.full, Channels::Rgba, |_| ProgressControl::Stop)
            .unwrap();
        // Stop on the first flushed pass (or run to completion if none) — either
        // way a full-shaped best-so-far image comes back.
        assert_eq!((img.width, img.height), (w, h));
        assert_eq!(img.data.len(), (w * h * 4) as usize);
    }
}
