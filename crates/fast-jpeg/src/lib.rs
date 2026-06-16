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

    let (out_w, out_h) = if scale > 1 {
        let target_w = (info.width as u32 / scale).max(1) as u16;
        let target_h = (info.height as u32 / scale).max(1) as u16;
        decoder
            .scale(target_w, target_h)
            .map_err(|e| JsValue::from_str(&e.to_string()))?
    } else {
        (info.width, info.height)
    };

    let pixels = decoder
        .decode()
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    let decoded = decoder
        .info()
        .ok_or_else(|| JsValue::from_str("no image info after decode"))?;

    let rgba = to_rgba(&pixels, decoded.pixel_format)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    Ok(DecodeResult {
        width: out_w as u32,
        height: out_h as u32,
        data: rgba,
    })
}

fn to_rgba(pixels: &[u8], format: PixelFormat) -> Result<Vec<u8>, String> {
    match format {
        PixelFormat::RGB24 => {
            if pixels.len() % 3 != 0 {
                return Err("rgb24 pixel buffer length is not divisible by 3".into());
            }
            let mut rgba = Vec::with_capacity((pixels.len() / 3) * 4);
            for chunk in pixels.chunks_exact(3) {
                rgba.extend_from_slice(chunk);
                rgba.push(255);
            }
            Ok(rgba)
        }
        PixelFormat::L8 => {
            let mut rgba = Vec::with_capacity(pixels.len() * 4);
            for &lum in pixels {
                rgba.extend_from_slice(&[lum, lum, lum, 255]);
            }
            Ok(rgba)
        }
        PixelFormat::L16 => Err("l16 output is not supported for rgba8".into()),
        PixelFormat::CMYK32 => Err("cmyk32 output is not supported for rgba8".into()),
    }
}