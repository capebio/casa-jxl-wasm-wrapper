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
unsafe fn make_rgba8_pixel_format(channels: u32) -> jpegxl_sys::common::types::JxlPixelFormat {
    jpegxl_sys::common::types::JxlPixelFormat {
        num_channels: channels,
        data_type: jpegxl_sys::common::types::JxlDataType::Uint8,
        endianness: jpegxl_sys::common::types::JxlEndianness::Native,
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
    use jpegxl_sys::metadata::codestream_header::JxlBasicInfo;
    use jpegxl_sys::decode::*;
    use std::mem::MaybeUninit;

    unsafe {
        let dec = JxlDecoderCreate(std::ptr::null());
        if dec.is_null() {
            return None;
        }
        let events = (JxlDecoderStatus::BasicInfo as std::os::raw::c_int)
            | (JxlDecoderStatus::FullImage as std::os::raw::c_int);
        if JxlDecoderSubscribeEvents(dec, events) != JxlDecoderStatus::Success {
            JxlDecoderDestroy(dec);
            return None;
        }
        if JxlDecoderSetInput(dec, jxl_bytes.as_ptr(), jxl_bytes.len()) != JxlDecoderStatus::Success
        {
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
                    if JxlDecoderImageOutBufferSize(dec, &pf, &mut size)
                        == JxlDecoderStatus::Success
                    {
                        out_buf.resize(size, 0);
                        if JxlDecoderSetImageOutBuffer(
                            dec,
                            &pf,
                            out_buf.as_mut_ptr() as *mut _,
                            size,
                        ) != JxlDecoderStatus::Success
                        {
                            status = JxlDecoderStatus::Error;
                            break;
                        }
                    }
                }
                JxlDecoderStatus::FullImage | JxlDecoderStatus::Success => break,
                JxlDecoderStatus::Error | JxlDecoderStatus::NeedMoreInput => break,
                _ => {}
            }
        }
        let elapsed = t0.elapsed();
        JxlDecoderDestroy(dec);
        if status == JxlDecoderStatus::FullImage || status == JxlDecoderStatus::Success {
            Some(elapsed)
        } else {
            None
        }
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

#[cfg(not(target_arch = "wasm32"))]
#[derive(Debug)]
pub enum DecodeProgressiveEvent<'a> {
    Progress {
        width: u32,
        height: u32,
        rgba: &'a [u8],
    },
    Final {
        width: u32,
        height: u32,
        rgba: Vec<u8>,
    },
}

/// Low-level progressive decode using FRAME_PROGRESSION events + FlushImage.
/// Invokes `on_frame` after each successful flush (partial passes + final).
/// Returns (time_to_first_usable_pixel_ms, total_wall_ms).
#[cfg(not(target_arch = "wasm32"))]
pub fn decode_progressive_frames_borrowed<F>(
    jxl_bytes: &[u8],
    mut on_frame: F,
) -> Option<(f64, f64)>
where
    F: FnMut(DecodeProgressiveEvent<'_>),
{
    use jpegxl_sys::metadata::codestream_header::JxlBasicInfo;
    use jpegxl_sys::decode::*;
    use std::mem::MaybeUninit;

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
        if JxlDecoderSetInput(dec, jxl_bytes.as_ptr(), jxl_bytes.len()) != JxlDecoderStatus::Success
        {
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
                        && JxlDecoderGetBasicInfo(dec, info.as_mut_ptr())
                            == JxlDecoderStatus::Success
                    {
                        let basic = std::ptr::read(info.as_mut_ptr());
                        image_w = basic.xsize;
                        image_h = basic.ysize;
                        pf = make_rgba8_pixel_format(4);
                    }
                }
                JxlDecoderStatus::NeedImageOutBuffer => {
                    let mut size: usize = 0;
                    if JxlDecoderImageOutBufferSize(dec, &pf, &mut size)
                        == JxlDecoderStatus::Success
                    {
                        out_buf.resize(size, 0);
                        if JxlDecoderSetImageOutBuffer(
                            dec,
                            &pf,
                            out_buf.as_mut_ptr() as *mut _,
                            size,
                        ) != JxlDecoderStatus::Success
                        {
                            status = JxlDecoderStatus::Error;
                            break;
                        }
                    }
                }
                JxlDecoderStatus::FrameProgression => {
                    if JxlDecoderFlushImage(dec) == JxlDecoderStatus::Success
                        && image_w > 0
                        && image_h > 0
                    {
                        if first_ms.is_none() {
                            first_ms = Some(ms(t_start.elapsed()));
                        }
                        on_frame(DecodeProgressiveEvent::Progress {
                            width: image_w,
                            height: image_h,
                            rgba: &out_buf,
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
            on_frame(DecodeProgressiveEvent::Final {
                width: image_w,
                height: image_h,
                rgba: out_buf,
            });
            Some((first_ms.unwrap_or(0.0), ms(total)))
        } else {
            None
        }
    }
}

/// Compatibility wrapper that clones progressive frames for callers that retain them.
#[cfg(not(target_arch = "wasm32"))]
pub fn decode_progressive_frames<F>(jxl_bytes: &[u8], mut on_frame: F) -> Option<(f64, f64)>
where
    F: FnMut(ProgressiveFrame),
{
    decode_progressive_frames_borrowed(jxl_bytes, |event| match event {
        DecodeProgressiveEvent::Progress {
            width,
            height,
            rgba,
        } => on_frame(ProgressiveFrame {
            width,
            height,
            rgba: rgba.to_vec(),
            is_final: false,
        }),
        DecodeProgressiveEvent::Final {
            width,
            height,
            rgba,
        } => on_frame(ProgressiveFrame {
            width,
            height,
            rgba,
            is_final: true,
        }),
    })
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
    pub bits_per_sample: u8, // 8 or 16
}

pub const JXTC_MAGIC: u32 = 0x4354_584a; // 'JXTC' little-endian
pub const JXTC_VERSION: u32 = 1;
pub const JXTC_HEADER_BYTES: usize = 32;
pub const JXTC_INDEX_ENTRY_BYTES: usize = 8;

/// Parse the 32-byte little-endian JXTC header.
/// Matches the layout in bridge.cpp (EncodeRgba*TileContainer) and the
/// updated parseJxtcHeader / JxtcHeader in packages/jxl-pyramid/src/tiling.ts
/// (including the flags word at offset 28: bit 0 = has_alpha, bit 1 = 16-bit).
#[cfg(not(target_arch = "wasm32"))]
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

/// Compute the list of (tile_x, tile_y) grid coordinates whose tiles overlap
/// the requested (clamped) viewport. We decode the *full* tile then crop
/// during the stitch (this matches the "decode_full per tile" model requested
/// for the native port and the non-worker path in the TS reference).
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

/// For a given full decoded tile at grid (tx,ty) and a viewport, compute the
/// source sub-rectangle inside the tile and the destination offset inside the
/// viewport buffer for the overlapping pixels. All coords in pixels (image space).
/// Returns (src_tile_x, src_tile_y, dst_view_x, dst_view_y, ow, oh) or None.
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

/// Decode one standalone per-tile JXL codestream (as stored inside JXTC containers)
/// to RGBA8 bytes + its decoded dimensions.
/// 
/// The implementation is a direct adaptation of the proven event loop in
/// `decode_full` (the only difference is that we return the pixel buffer).
/// Existing benchmark callers of decode_full are unaffected.
#[cfg(not(target_arch = "wasm32"))]
pub fn decode_jxl_rgba8(jxl_bytes: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    use std::mem::MaybeUninit;
    use jpegxl_sys::decode::*;
    use jpegxl_sys::metadata::codestream_header::JxlBasicInfo;

    unsafe {
        let dec = JxlDecoderCreate(std::ptr::null());
        if dec.is_null() {
            return None;
        }
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
        let mut w: u32 = 0;
        let mut h: u32 = 0;
        let mut status;
        loop {
            status = JxlDecoderProcessInput(dec);
            match status {
                JxlDecoderStatus::BasicInfo => {
                    if JxlDecoderGetBasicInfo(dec, info.as_mut_ptr()) == JxlDecoderStatus::Success {
                        let basic = std::ptr::read(info.as_mut_ptr());
                        w = basic.xsize;
                        h = basic.ysize;
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
        JxlDecoderDestroy(dec);
        if (status == JxlDecoderStatus::FullImage || status == JxlDecoderStatus::Success)
            && !out_buf.is_empty()
            && w > 0
            && h > 0
        {
            Some((out_buf, w, h))
        } else {
            None
        }
    }
}

/// 16-bit (rgba16) equivalent for JXTC-16 containers. Same structure, Uint16 data type.
#[cfg(not(target_arch = "wasm32"))]
pub fn decode_jxl_rgba16(jxl_bytes: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    use std::mem::MaybeUninit;
    use jpegxl_sys::decode::*;
    use jpegxl_sys::metadata::codestream_header::JxlBasicInfo;

    unsafe {
        let dec = JxlDecoderCreate(std::ptr::null());
        if dec.is_null() {
            return None;
        }
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
        let mut pf = jpegxl_sys::common::types::JxlPixelFormat {
            num_channels: 4,
            data_type: jpegxl_sys::common::types::JxlDataType::Uint16,
            endianness: jpegxl_sys::common::types::JxlEndianness::Native,
            align: 0,
        };
        let mut out_buf: Vec<u8> = Vec::new();
        let mut w: u32 = 0;
        let mut h: u32 = 0;
        let mut status;
        loop {
            status = JxlDecoderProcessInput(dec);
            match status {
                JxlDecoderStatus::BasicInfo => {
                    if JxlDecoderGetBasicInfo(dec, info.as_mut_ptr()) == JxlDecoderStatus::Success {
                        let basic = std::ptr::read(info.as_mut_ptr());
                        w = basic.xsize;
                        h = basic.ysize;
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
        JxlDecoderDestroy(dec);
        if (status == JxlDecoderStatus::FullImage || status == JxlDecoderStatus::Success)
            && !out_buf.is_empty()
            && w > 0
            && h > 0
        {
            Some((out_buf, w, h))
        } else {
            None
        }
    }
}

/// Decode a rectangular viewport from a JXTC tile container (the native/rayon
/// equivalent of the browser JXTC ROI path).
///
/// The implementation follows the exact algorithm requested for PR-10b:
///   Step A: header parse + compute overlapping tiles (tx,ty) using the same
///           floor-division + clamping rules as the TS reference.
///   Step B: rayon par_iter over the overlapping tiles. For each, locate the
///           tile's JXL bytes via the index table that follows the header,
///           call decode_jxl_rgba* (full tile), collect the results.
///   Step C: after the parallel phase, single-threaded block-copy stitch of
///           the intersecting sub-rectangles (row-by-row copy_from_slice)
///           into a destination buffer allocated for exactly the (clamped)
///           viewport size, using the correct bpp from the header.
///
/// The returned Vec contains packed pixels for the viewport region
/// (row-major, 4 bytes/pixel for 8-bit or 8 bytes/pixel for 16-bit).
/// The caller is responsible for knowing the output dimensions (the clamped
/// rw/rh) and the bit depth (from the header or by inspecting the first level).
///
/// This function expects the *full* JXTC container bytes for the level
/// (as stored for massive top-level pyramid entries). It does not implement
/// on-disk sliding-window source tiling of the original master image.
#[cfg(not(target_arch = "wasm32"))]
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

    // Parse the per-tile index table (immediately after the 32-byte header).
    // Each entry is (offset u32 LE, length u32 LE).
    let num_tiles = (header.tiles_x as usize) * (header.tiles_y as usize);
    let index_start = JXTC_HEADER_BYTES;
    let index_end = index_start + num_tiles * JXTC_INDEX_ENTRY_BYTES;
    if container.len() < index_end {
        return None;
    }

    let mut tile_index: Vec<(u32, u32)> = Vec::with_capacity(num_tiles);
    for i in 0..num_tiles {
        let base = index_start + i * JXTC_INDEX_ENTRY_BYTES;
        let off = u32::from_le_bytes(container[base..base + 4].try_into().ok()?);
        let len = u32::from_le_bytes(container[base + 4..base + 8].try_into().ok()?);
        tile_index.push((off, len));
    }

    // Compute which tiles (grid coords) we need.
    let overlapping = overlapping_tile_indices(&header, ImageRegion { x: rx, y: ry, w: rw, h: rh });

    // Parallel phase: decode the full per-tile JXL codestreams.
    // This is the direct analogue of farming small regions to workers in the
    // browser pooled path, except here each "worker" is a rayon thread and
    // we decode the entire (small) tile because the stored data is a
    // standalone JXL per tile.
    let decoded_tiles: Vec<((u32, u32), Vec<u8>, u32, u32)> = overlapping
        .par_iter()
        .filter_map(|&(tx, ty)| {
            let idx = (ty * header.tiles_x + tx) as usize;
            let (off, len) = *tile_index.get(idx)?;
            let start = off as usize;
            let end = start + len as usize;
            if end > container.len() {
                return None;
            }
            let tile_jxl = &container[start..end];

            let (pixels, tw, th) = if header.bits_per_sample == 16 {
                decode_jxl_rgba16(tile_jxl)?
            } else {
                decode_jxl_rgba8(tile_jxl)?
            };

            // The decoded tile must match the size implied by the grid
            // (edge tiles can be smaller than tile_size).
            let exp_w = header.tile_size.min(header.image_w - tx * header.tile_size);
            let exp_h = header.tile_size.min(header.image_h - ty * header.tile_size);
            if tw != exp_w || th != exp_h {
                return None;
            }

            Some(((tx, ty), pixels, tw, th))
        })
        .collect();

    // Allocate exact output buffer for the viewport region.
    let mut dest = vec![0u8; (rw as usize) * (rh as usize) * bpp];

    // Serial stitch. Safe: all writes happen after the parallel collect.
    // We use the same intersection arithmetic as the TS stitch and the C++
    // DecodeRgba*TileContainerRegion.
    for ((tx, ty), tile_pixels, tw, th) in decoded_tiles {
        if let Some((src_x, src_y, dst_x, dst_y, ow, oh)) =
            compute_tile_copy_rects(&header, tx, ty, rx, ry, rw, rh, tw, th)
        {
            for row in 0..oh {
                let src_row_off = ((src_y + row) * tw + src_x) as usize * bpp;
                let dst_row_off = ((dst_y + row) * rw + dst_x) as usize * bpp;
                let row_bytes = (ow as usize) * bpp;

                dest[dst_row_off..dst_row_off + row_bytes]
                    .copy_from_slice(&tile_pixels[src_row_off..src_row_off + row_bytes]);
            }
        }
    }

    Some(dest)
}

// Re-export the pure math pieces so the Tauri pyramid_store / pipeline layers
// can reuse the same header parsing and tile coordinate logic if they prefer
// to manage tile byte extraction (mmap, caching, etc.) themselves.
pub use overlapping_tile_indices as jxtc_overlapping_tile_indices;
pub use parse_jxtc_header as jxtc_parse_header;

// rayon is already used elsewhere in the crate (demosaic, dng, pipeline downscalers).
// We bring the parallel iterator extension into scope for the JXTC path.
#[cfg(not(target_arch = "wasm32"))]
use rayon::prelude::*;
