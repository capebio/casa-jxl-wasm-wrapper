use std::io::Cursor;

use jpeg_decoder::{Decoder, PixelFormat};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct DecodeResult {
    width: u32,
    height: u32,
    data: Vec<u8>,
}

#[wasm_bindgen]
impl DecodeResult {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.width
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.height
    }

    #[wasm_bindgen(getter)]
    pub fn data(&self) -> Vec<u8> {
        self.data.clone()
    }

    /// Consuming accessor — moves the pixel buffer out without cloning.
    /// Prefer this over `data` when you only need the pixels once.
    #[wasm_bindgen]
    pub fn take_data(self) -> Vec<u8> {
        self.data
    }
}

/// Decode a JPEG buffer to RGBA, with DCT-domain downscale.
/// `denom`: 1 (full), 2 (half), 4 (quarter), 8 (eighth). Other values clamp to 1.
#[wasm_bindgen]
pub fn decode_scaled(jpeg: &[u8], denom: u8) -> Result<DecodeResult, JsValue> {
    let scale = match denom {
        2 | 4 | 8 => denom as u32,
        _ => 1,
    };

    let mut decoder = Decoder::new(Cursor::new(jpeg));
    decoder
        .read_info()
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    let info = decoder
        .info()
        .ok_or_else(|| JsValue::from_str("no image info after read_info"))?;

    // Decompression-bomb guard: reject images whose decoded pixel count exceeds 400 MP.
    // This prevents OOM from crafted JPEG files with huge dimensions.
    const MAX_PIXELS: u64 = 400_000_000;
    if (info.width as u64).saturating_mul(info.height as u64) > MAX_PIXELS {
        return Err(JsValue::from_str(&format!(
            "image too large: {}×{} exceeds {} pixel limit",
            info.width, info.height, MAX_PIXELS
        )));
    }

    if scale > 1 {
        let target_w = (info.width as u32 / scale).max(1) as u16;
        let target_h = (info.height as u32 / scale).max(1) as u16;
        decoder
            .scale(target_w, target_h)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
    }

    let pixels = decoder
        .decode()
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    let decoded = decoder
        .info()
        .ok_or_else(|| JsValue::from_str("no image info after decode"))?;

    let rgba = to_rgba(&pixels, decoded.pixel_format)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    Ok(DecodeResult {
        width: decoded.width as u32,
        height: decoded.height as u32,
        data: rgba,
    })
}

fn to_rgba(pixels: &[u8], format: PixelFormat) -> Result<Vec<u8>, String> {
    match format {
        PixelFormat::RGB24 => {
            if pixels.len() % 3 != 0 {
                return Err("rgb24 pixel buffer length is not divisible by 3".into());
            }
            // Prefill alpha=255 with one vectorized memset, then copy the 3-byte
            // RGB runs into a fixed-size buffer. Avoids the per-pixel length-bump +
            // capacity check of extend_from_slice/push (~45-56% faster @12-24MP;
            // see examples/to_rgba_flip.rs). Byte-exact with the old loop.
            let mut rgba = vec![255u8; (pixels.len() / 3) * 4];
            for (dst, src) in rgba.chunks_exact_mut(4).zip(pixels.chunks_exact(3)) {
                dst[..3].copy_from_slice(src);
            }
            Ok(rgba)
        }
        PixelFormat::L8 => {
            let capacity = pixels
                .len()
                .checked_mul(4)
                .ok_or_else(|| "L8 pixel buffer too large".to_string())?;
            // Same prefill-then-write strategy as RGB24 (~31-42% faster).
            let mut rgba = vec![255u8; capacity];
            for (dst, &lum) in rgba.chunks_exact_mut(4).zip(pixels) {
                dst[0] = lum;
                dst[1] = lum;
                dst[2] = lum;
            }
            Ok(rgba)
        }
        PixelFormat::L16 => Err("UnsupportedFormat:l16 — 16-bit grayscale output is not supported for rgba8".into()),
        PixelFormat::CMYK32 => Err("UnsupportedFormat:cmyk32 — CMYK output is not supported for rgba8".into()),
    }
}