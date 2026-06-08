//! Low-level stateful JXL decoder on top of jpegxl-sys (gated by `jxl-lowlevel` feature).
//!
//! Reference implementation for the Tauri / native parity work (see
//! docs/HANDOFF-tauri-parity-continuation-2026-06-04.md and Tauri-progressive-implementation.md).
//!
//! Goals for native (different cost model from WASM):
//! - Keep *JxlDecoder alive across chunks or full buffer* (no repeated prefix re-decodes).
//! - Use JXL_DEC_FRAME_PROGRESSION + JxlDecoderFlushImage to surface DC / early passes
//!   as soon as they are available; paint directly to egui/wgpu texture from Rust (no IPC hop).
//! - For ROI/subject crops: JxlDecoderSetCropEnabled (when binding present) + sized
//!   JxlImageOutBuffer before ProcessInput so libjxl decodes *only* the requested rect.
//! - Emit the same metric names the WASM side and bench use:
//!   decode_buffer_extract_ms (near 0: direct ownership), decode_region_downsample_ms,
//!   source_pixels_decoded (the win: full 20 Mpx vs 16 kpx for 128 px subject), time_to_first_pixel_ms.
//!
//! Current vendored libjxl 0.10 (via jpegxl-sys 0.10) does not expose SetCropEnabled in the
//! generated bindings used here, so real native-crop from a full codestream is not yet possible
//! in this slice. The fast path demonstrated by the harness is:
//! - At encode time (when _subjects/_crop sidecars present): after process_rgba, crop the
//!   RGBA8 and emit a *dedicated small JXL* (or start of a JXTC/tiled container). Decode that
//!   small asset for thumbs/focus views (already <3 ms @128 px even on high-variance runs).
//! - Later: when bindings or JXTC reader lands, add the SetCrop + tile-selection paths here
//!   and surface "native-crop" / "jxtc" strategies in metrics.
//!
//! The functions here perform a *single* decode (the caller / bench does min-of-N if desired).
//! They are intentionally close to the pseudocode in the handoff so Tauri can adopt or call them.

use std::time::{Duration, Instant};

#[cfg(not(target_arch = "wasm32"))]
unsafe fn make_rgba8_pixel_format(channels: u32) -> jpegxl_sys::types::JxlPixelFormat {
    jpegxl_sys::types::JxlPixelFormat {
        num_channels: channels,
        data_type: jpegxl_sys::types::JxlDataType::Uint8,
        endianness: jpegxl_sys::types::JxlEndianness::Native,
        align: 0,
    }
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

/// Decode a JXL (full image) using the low-level stateful API.
/// Returns the wall time for the complete decode (BasicInfo + NeedOutBuffer + FullImage).
/// Single execution; caller typically takes min over runs for benchmarks.
#[cfg(not(target_arch = "wasm32"))]
pub fn decode_full(jxl_bytes: &[u8]) -> Option<Duration> {
    use std::mem::MaybeUninit;
    use jpegxl_sys::decode::*;
    use jpegxl_sys::codestream_header::JxlBasicInfo;

    unsafe {
        let dec = JxlDecoderCreate(std::ptr::null());
        if dec.is_null() { return None; }
        let events = (JxlDecoderStatus::BasicInfo as std::os::raw::c_int)
            | (JxlDecoderStatus::FullImage as std::os::raw::c_int);
        if JxlDecoderSubscribeEvents(dec, events) != JxlDecoderStatus::Success {
            JxlDecoderDestroy(dec);
            return None;
        }
        if JxlDecoderSetInput(dec, jxl_bytes.as_ptr(), jxl_bytes.len()) != JxlDecoderStatus::Success {
            JxlDecoderDestroy(dec);
            return None;
        }

        let mut info: MaybeUninit<JxlBasicInfo> = MaybeUninit::uninit();
        let mut pf = make_rgba8_pixel_format(4);
        let mut out_buf: Vec<u8> = Vec::new();
        let mut status;
        let t0 = Instant::now();
        loop {
            status = JxlDecoderProcessInput(dec);
            match status {
                JxlDecoderStatus::BasicInfo => {
                    if JxlDecoderGetBasicInfo(dec, info.as_mut_ptr()) == JxlDecoderStatus::Success {
                        pf = make_rgba8_pixel_format(4);
                    }
                }
                JxlDecoderStatus::NeedImageOutBuffer => {
                    let mut size: usize = 0;
                    if JxlDecoderImageOutBufferSize(dec, &pf, &mut size) == JxlDecoderStatus::Success {
                        out_buf.resize(size, 0);
                        let _ = JxlDecoderSetImageOutBuffer(dec, &pf, out_buf.as_mut_ptr() as *mut _, size);
                    }
                }
                JxlDecoderStatus::FullImage | JxlDecoderStatus::Success => break,
                JxlDecoderStatus::Error | JxlDecoderStatus::NeedMoreInput => break,
                _ => {}
            }
        }
        let elapsed = t0.elapsed();
        JxlDecoderDestroy(dec);
        if status == JxlDecoderStatus::FullImage || status == JxlDecoderStatus::Success { Some(elapsed) } else { None }
    }
}

/// One progressive decode pass surfaced after `JxlDecoderFlushImage`.
#[cfg(not(target_arch = "wasm32"))]
#[derive(Clone, Debug)]
pub struct ProgressiveFrame {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
    pub is_final: bool,
}

/// Low-level progressive decode using FRAME_PROGRESSION events + FlushImage.
/// Invokes `on_frame` after each successful flush (partial passes + final).
/// Returns (time_to_first_usable_pixel_ms, total_wall_ms).
#[cfg(not(target_arch = "wasm32"))]
pub fn decode_progressive_frames<F>(jxl_bytes: &[u8], mut on_frame: F) -> Option<(f64, f64)>
where
    F: FnMut(ProgressiveFrame),
{
    use std::mem::MaybeUninit;
    use jpegxl_sys::decode::*;
    use jpegxl_sys::codestream_header::JxlBasicInfo;

    unsafe {
        let dec = JxlDecoderCreate(std::ptr::null());
        if dec.is_null() {
            return None;
        }
        let events = (JxlDecoderStatus::BasicInfo as std::os::raw::c_int)
            | (JxlDecoderStatus::FrameProgression as std::os::raw::c_int)
            | (JxlDecoderStatus::FullImage as std::os::raw::c_int);
        if JxlDecoderSubscribeEvents(dec, events) != JxlDecoderStatus::Success {
            JxlDecoderDestroy(dec);
            return None;
        }
        let _ = JxlDecoderSetProgressiveDetail(dec, JxlProgressiveDetail::Passes);
        if JxlDecoderSetInput(dec, jxl_bytes.as_ptr(), jxl_bytes.len()) != JxlDecoderStatus::Success {
            JxlDecoderDestroy(dec);
            return None;
        }

        let mut info: MaybeUninit<JxlBasicInfo> = MaybeUninit::uninit();
        let mut image_w: u32 = 0;
        let mut image_h: u32 = 0;
        let mut pf = make_rgba8_pixel_format(4);
        let mut out_buf: Vec<u8> = Vec::new();
        let mut first_ms: Option<f64> = None;
        let t_start = Instant::now();
        let mut status;
        loop {
            status = JxlDecoderProcessInput(dec);
            match status {
                JxlDecoderStatus::BasicInfo => {
                    if image_w == 0
                        && JxlDecoderGetBasicInfo(dec, info.as_mut_ptr()) == JxlDecoderStatus::Success
                    {
                        let basic = unsafe { std::ptr::read(info.as_mut_ptr()) };
                        image_w = basic.xsize;
                        image_h = basic.ysize;
                        pf = make_rgba8_pixel_format(4);
                    }
                }
                JxlDecoderStatus::NeedImageOutBuffer => {
                    let mut size: usize = 0;
                    if JxlDecoderImageOutBufferSize(dec, &pf, &mut size) == JxlDecoderStatus::Success {
                        out_buf.resize(size, 0);
                        let _ = JxlDecoderSetImageOutBuffer(dec, &pf, out_buf.as_mut_ptr() as *mut _, size);
                    }
                }
                JxlDecoderStatus::FrameProgression => {
                    if JxlDecoderFlushImage(dec) == JxlDecoderStatus::Success && image_w > 0 && image_h > 0 {
                        if first_ms.is_none() {
                            first_ms = Some(ms(t_start.elapsed()));
                        }
                        on_frame(ProgressiveFrame {
                            width: image_w,
                            height: image_h,
                            rgba: out_buf.clone(),
                            is_final: false,
                        });
                    }
                }
                JxlDecoderStatus::FullImage | JxlDecoderStatus::Success => break,
                JxlDecoderStatus::Error | JxlDecoderStatus::NeedMoreInput => break,
                _ => {}
            }
        }
        let total = t_start.elapsed();
        JxlDecoderDestroy(dec);
        if (status == JxlDecoderStatus::FullImage || status == JxlDecoderStatus::Success)
            && !out_buf.is_empty()
            && image_w > 0
            && image_h > 0
        {
            on_frame(ProgressiveFrame {
                width: image_w,
                height: image_h,
                rgba: out_buf,
                is_final: true,
            });
            Some((first_ms.unwrap_or(0.0), ms(total)))
        } else {
            None
        }
    }
}

/// Timing-only wrapper around [`decode_progressive_frames`].
#[cfg(not(target_arch = "wasm32"))]
pub fn decode_progressive_first_total(jxl_bytes: &[u8]) -> Option<(f64, f64)> {
    decode_progressive_frames(jxl_bytes, |_| {})
}

// For backwards compatibility inside this workspace bench (can be removed later).
#[cfg(not(target_arch = "wasm32"))]
pub use decode_full as bench_jxl_decode_lowlevel_full;
#[cfg(not(target_arch = "wasm32"))]
pub use decode_progressive_first_total as bench_jxl_decode_lowlevel_progressive;
