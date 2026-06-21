# Multi-format Image Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a browser user upload PNG/JPEG/GIF/WebP/AVIF/TIFF/EXR (plus existing RAW+JXL) and decode each cleanly into the convert/preview pipeline, preserving high bit depth for EXR (f32) and 16-bit TIFF.

**Architecture:** Bit-depth-aware hybrid. SDR formats (PNG/JPEG/GIF/WebP/AVIF) decode browser-native via `createImageBitmap` (already done in `processImageFile`). High-bit formats (EXR→f32, TIFF→u8/u16) decode in `raw-pipeline` (wasm) using the `image` crate already in its deps (add the `exr` feature). A JS `detectFormat` dispatcher routes each upload. A Rust-generated Mandelbrot EXR + 16-bit TIFF proves a clean round-trip.

**Tech Stack:** Rust (`raw-pipeline`, `wasm-bindgen`), the `image` crate 0.25 (tiff/png/jpeg/webp + new `exr` feature), JS (`web/`), `cargo test` + Playwright.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `crates/raw-pipeline/Cargo.toml` | add `exr` feature to `image`; new `image-formats` feature flag | Modify |
| `crates/raw-pipeline/src/image_formats.rs` | pure-Rust decoders: `decode_tiff_bytes`, `decode_exr_bytes`, `f32_linear_to_srgb8` | Create |
| `crates/raw-pipeline/src/lib.rs` | `pub mod image_formats;` | Modify |
| `crates/raw-pipeline/src/bin/gen_fractal.rs` | Rust Mandelbrot generator → EXR(f32) + TIFF(u16/u8) | Create |
| `crates/raw-pipeline/tests/image_formats_roundtrip.rs` | native round-trip tests over the synthetic files | Create |
| `src/lib.rs` (wasm crate) | `DecodedImage` wasm struct + `decode_tiff`/`decode_exr` exports | Modify |
| `web/format-detect.js` | `detectFormat(bytes, name)` magic-byte classifier | Create |
| `web/format-detect.test.js` | unit tests for `detectFormat` | Create |
| `web/jxl-benchmark.js` | route via `detectFormat`; wire exr/tiff → wasm, widen `accept` | Modify |
| `web/multi-format-roundtrip.test.mjs` | Playwright in-browser clean-output check | Create |

**Decoder data contract (shared):**
```rust
// crates/raw-pipeline/src/image_formats.rs
pub struct DecodedRgba {
    pub width: u32,
    pub height: u32,
    pub bit_depth: u8,      // 8, 16, or 32 (32 = f32)
    pub u8:  Vec<u8>,       // populated when bit_depth == 8  (RGBA8, 4 B/px)
    pub u16: Vec<u16>,      // populated when bit_depth == 16 (RGBA16, 4 samples/px)
    pub f32: Vec<f32>,      // populated when bit_depth == 32 (RGBA f32, 4 samples/px)
}
```
Exactly one of `u8`/`u16`/`f32` is non-empty per result. Always RGBA (4 channels) to keep the wasm/JS boundary uniform.

---

## Task 1: Enable `image` EXR feature + wasm build sanity

**Files:**
- Modify: `crates/raw-pipeline/Cargo.toml`

- [ ] **Step 1: Confirm the current wasm build works (baseline)**

Run: `wasm-pack build --target web --out-dir pkg --release`
Expected: PASS (establishes the baseline before adding `exr`).

- [ ] **Step 2: Add the `exr` image feature + a gating feature flag**

In `crates/raw-pipeline/Cargo.toml`, change the `image` dependency line and add a feature:
```toml
[features]
default = ["parallel", "jxl-codec"]
parallel = ["dep:rayon"]
jxl-codec = ["dep:jxl-ffi", "dep:half", "dep:rayon"]
c-perceptual = []
image-formats = []   # gates the decoders; always-on in wasm/native, kept explicit

[dependencies]
image = { version = "0.25", default-features = false, features = ["jpeg", "png", "tiff", "webp", "exr"] }
```
(Drop `avif` from the image feature list — AVIF is browser-native; image's avif decode pulls a C `dav1d` dep that does not cross-compile to wasm. Keep `exr` which is pure-Rust.)

- [ ] **Step 3: Verify the wasm build still links with `exr` added**

Run: `wasm-pack build --target web --out-dir pkg --release`
Expected: PASS. If the `exr` crate pulls a default `threads` feature that breaks wasm, pin it explicitly in `[dependencies]`: `exr = { version = "1.72", default-features = false }` and re-run.

- [ ] **Step 4: Commit**
```bash
git add crates/raw-pipeline/Cargo.toml
git commit -m "build(raw-pipeline): add image exr feature for high-bit ingestion"
```

---

## Task 2: TIFF decoder (u8 + u16) in raw-pipeline

**Files:**
- Create: `crates/raw-pipeline/src/image_formats.rs`
- Modify: `crates/raw-pipeline/src/lib.rs`

- [ ] **Step 1: Register the module**

In `crates/raw-pipeline/src/lib.rs`, after `pub mod tiff;` add:
```rust
pub mod image_formats;
```

- [ ] **Step 2: Write the failing test**

Append to `crates/raw-pipeline/src/image_formats.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    // 2x1 RGB8 TIFF, red then green, encoded by the image crate itself.
    fn make_rgb8_tiff() -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        let img = image::RgbImage::from_raw(2, 1, vec![255, 0, 0, 0, 255, 0]).unwrap();
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut buf, image::ImageFormat::Tiff)
            .unwrap();
        buf.into_inner()
    }

    #[test]
    fn decode_tiff_rgb8_to_rgba8() {
        let d = decode_tiff_bytes(&make_rgb8_tiff()).unwrap();
        assert_eq!((d.width, d.height, d.bit_depth), (2, 1, 8));
        assert_eq!(&d.u8[..8], &[255, 0, 0, 255, 0, 255, 0, 255]); // R, A=255, G, A=255
        assert!(d.u16.is_empty() && d.f32.is_empty());
    }
}
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `cd crates/raw-pipeline && cargo test --no-default-features --features image-formats decode_tiff_rgb8 -- --nocapture`
Expected: FAIL — `decode_tiff_bytes` not found / `DecodedRgba` not found.

- [ ] **Step 4: Implement the struct + TIFF decoder**

Put this at the TOP of `crates/raw-pipeline/src/image_formats.rs` (above the test module):
```rust
//! Pure-Rust decoders for already-developed RGB image formats (TIFF, EXR),
//! built on the `image` crate already in raw-pipeline's deps. Distinct from
//! `tiff.rs`, which parses RAW (Bayer) TIFF containers. Output is always RGBA.

use image::DynamicImage;

#[derive(thiserror::Error, Debug)]
pub enum ImageFormatError {
    #[error("image decode failed: {0}")]
    Decode(String),
}

/// RGBA pixel buffer at a single bit depth. Exactly one of u8/u16/f32 is set.
#[derive(Default)]
pub struct DecodedRgba {
    pub width: u32,
    pub height: u32,
    pub bit_depth: u8,
    pub u8: Vec<u8>,
    pub u16: Vec<u16>,
    pub f32: Vec<f32>,
}

/// Decode a general RGB(A) TIFF. 16-bit files keep 16 bits; everything else
/// collapses to RGBA8.
pub fn decode_tiff_bytes(bytes: &[u8]) -> Result<DecodedRgba, ImageFormatError> {
    let img = image::load_from_memory_with_format(bytes, image::ImageFormat::Tiff)
        .map_err(|e| ImageFormatError::Decode(e.to_string()))?;
    Ok(dynamic_to_rgba(img))
}

/// Pick 16-bit output when the source is >8-bit, else 8-bit. Always RGBA.
fn dynamic_to_rgba(img: DynamicImage) -> DecodedRgba {
    let (width, height) = (img.width(), img.height());
    let sixteen = matches!(
        img.color(),
        image::ColorType::L16
            | image::ColorType::La16
            | image::ColorType::Rgb16
            | image::ColorType::Rgba16
    );
    if sixteen {
        let rgba = img.to_rgba16();
        DecodedRgba { width, height, bit_depth: 16, u16: rgba.into_raw(), ..Default::default() }
    } else {
        let rgba = img.to_rgba8();
        DecodedRgba { width, height, bit_depth: 8, u8: rgba.into_raw(), ..Default::default() }
    }
}
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `cd crates/raw-pipeline && cargo test --no-default-features --features image-formats decode_tiff_rgb8 -- --nocapture`
Expected: PASS.

- [ ] **Step 6: Commit**
```bash
git add crates/raw-pipeline/src/image_formats.rs crates/raw-pipeline/src/lib.rs
git commit -m "feat(raw-pipeline): general RGB TIFF decoder (u8/u16) via image crate"
```

---

## Task 3: 16-bit TIFF path + EXR (f32) decoder

**Files:**
- Modify: `crates/raw-pipeline/src/image_formats.rs`

- [ ] **Step 1: Write failing tests (16-bit TIFF + EXR f32)**

Add inside the `tests` module in `image_formats.rs`:
```rust
fn make_rgb16_tiff() -> Vec<u8> {
    let mut buf = std::io::Cursor::new(Vec::new());
    let img: image::ImageBuffer<image::Rgb<u16>, Vec<u16>> =
        image::ImageBuffer::from_raw(1, 1, vec![65535, 1000, 0]).unwrap();
    image::DynamicImage::ImageRgb16(img)
        .write_to(&mut buf, image::ImageFormat::Tiff).unwrap();
    buf.into_inner()
}

fn make_rgba32f_exr() -> Vec<u8> {
    let mut buf = std::io::Cursor::new(Vec::new());
    // one HDR pixel above 1.0 to prove float range survives
    let img: image::ImageBuffer<image::Rgba<f32>, Vec<f32>> =
        image::ImageBuffer::from_raw(1, 1, vec![4.0, 0.5, 0.0, 1.0]).unwrap();
    image::DynamicImage::ImageRgba32F(img)
        .write_to(&mut buf, image::ImageFormat::OpenExr).unwrap();
    buf.into_inner()
}

#[test]
fn decode_tiff_rgb16_keeps_16bit() {
    let d = decode_tiff_bytes(&make_rgb16_tiff()).unwrap();
    assert_eq!(d.bit_depth, 16);
    assert_eq!(&d.u16[..4], &[65535, 1000, 0, 65535]); // R G B, A=65535
}

#[test]
fn decode_exr_keeps_f32_hdr() {
    let d = decode_exr_bytes(&make_rgba32f_exr()).unwrap();
    assert_eq!((d.width, d.height, d.bit_depth), (1, 1, 32));
    assert!((d.f32[0] - 4.0).abs() < 1e-4, "HDR value >1.0 must survive: {}", d.f32[0]);
    assert!((d.f32[3] - 1.0).abs() < 1e-4);
}
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd crates/raw-pipeline && cargo test --no-default-features --features image-formats decode_exr -- --nocapture`
Expected: FAIL — `decode_exr_bytes` not found.

- [ ] **Step 3: Implement the EXR decoder**

Add to `image_formats.rs` (below `decode_tiff_bytes`):
```rust
/// Decode an OpenEXR image to interleaved RGBA f32 (linear, scene-referred).
/// HDR values above 1.0 are preserved.
pub fn decode_exr_bytes(bytes: &[u8]) -> Result<DecodedRgba, ImageFormatError> {
    let img = image::load_from_memory_with_format(bytes, image::ImageFormat::OpenExr)
        .map_err(|e| ImageFormatError::Decode(e.to_string()))?;
    let (width, height) = (img.width(), img.height());
    let rgba = img.to_rgba32f();
    Ok(DecodedRgba { width, height, bit_depth: 32, f32: rgba.into_raw(), ..Default::default() })
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `cd crates/raw-pipeline && cargo test --no-default-features --features image-formats image_formats -- --nocapture`
Expected: PASS (all four image_formats tests).

- [ ] **Step 5: Commit**
```bash
git add crates/raw-pipeline/src/image_formats.rs
git commit -m "feat(raw-pipeline): EXR f32 decoder + 16-bit TIFF path"
```

---

## Task 4: f32 → display (linear→sRGB 8-bit) conversion

**Files:**
- Modify: `crates/raw-pipeline/src/image_formats.rs`

- [ ] **Step 1: Write the failing test**

Add to the `tests` module:
```rust
#[test]
fn f32_linear_to_srgb8_maps_and_clamps() {
    // linear 0 -> 0; linear 1 -> 255; linear >1 clamps to 255; alpha passes through scaled.
    let lin = [0.0_f32, 1.0, 4.0, 1.0,   0.5, 0.5, 0.5, 0.25];
    let out = f32_linear_to_srgb8(&lin);
    assert_eq!(out[0], 0);
    assert_eq!(out[1], 255);
    assert_eq!(out[2], 255);            // HDR clamp
    assert_eq!(out[3], 255);            // alpha 1.0 -> 255
    // sRGB(0.5 linear) ~ 0.7353 -> ~188
    assert!((out[4] as i32 - 188).abs() <= 1, "got {}", out[4]);
    assert_eq!(out[7], 64);             // alpha 0.25 -> 64 (linear, no sRGB on alpha)
}
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd crates/raw-pipeline && cargo test --no-default-features --features image-formats f32_linear_to_srgb8 -- --nocapture`
Expected: FAIL — function not found.

- [ ] **Step 3: Implement**

Add to `image_formats.rs`:
```rust
/// Convert interleaved RGBA f32 (linear) to RGBA8 for display/preview.
/// Colour channels get the sRGB OETF; alpha is linear-scaled. HDR clamps to 1.0.
pub fn f32_linear_to_srgb8(rgba_f32: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(rgba_f32.len());
    for px in rgba_f32.chunks_exact(4) {
        for &c in &px[..3] {
            let c = c.clamp(0.0, 1.0);
            let s = if c <= 0.0031308 { 12.92 * c } else { 1.055 * c.powf(1.0 / 2.4) - 0.055 };
            out.push((s * 255.0 + 0.5) as u8);
        }
        out.push((px[3].clamp(0.0, 1.0) * 255.0 + 0.5) as u8);
    }
    out
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `cd crates/raw-pipeline && cargo test --no-default-features --features image-formats f32_linear_to_srgb8 -- --nocapture`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add crates/raw-pipeline/src/image_formats.rs
git commit -m "feat(raw-pipeline): f32 linear->sRGB8 display conversion"
```

---

## Task 5: WASM exports — `DecodedImage` + `decode_tiff`/`decode_exr`

**Files:**
- Modify: `src/lib.rs` (wasm crate root)
- Modify: root `Cargo.toml` (forward `image-formats` to wasm build)

- [ ] **Step 1: Make the wasm crate build raw-pipeline with image-formats**

In root `Cargo.toml`, add `image-formats` to the wasm `raw-pipeline` dependency:
```toml
raw-pipeline = { path = "crates/raw-pipeline", default-features = false, features = ["image-formats"] }
```
(Leave the `cfg(not(wasm32))` native entry adding `jxl-codec` as-is, but also append `"image-formats"` to its feature list.)

- [ ] **Step 2: Add the wasm bindings**

Append to `src/lib.rs`:
```rust
/// Decoded non-RAW image handed to JS. One of the take_* buffers is non-empty,
/// selected by `bit_depth` (8 -> take_rgba8, 16 -> take_rgba16_le, 32 -> take_rgba_f32).
#[wasm_bindgen]
pub struct DecodedImage {
    width: u32,
    height: u32,
    bit_depth: u8,
    u8buf: Vec<u8>,
    u16buf: Vec<u16>,
    f32buf: Vec<f32>,
}

#[wasm_bindgen]
impl DecodedImage {
    #[wasm_bindgen(getter)] pub fn width(&self) -> u32 { self.width }
    #[wasm_bindgen(getter)] pub fn height(&self) -> u32 { self.height }
    #[wasm_bindgen(getter)] pub fn bit_depth(&self) -> u8 { self.bit_depth }

    /// RGBA8 (bit_depth == 8). Empty otherwise.
    pub fn take_rgba8(&mut self) -> Vec<u8> { std::mem::take(&mut self.u8buf) }
    /// RGBA16 packed little-endian, 8 bytes/px (bit_depth == 16). Empty otherwise.
    pub fn take_rgba16_le(&mut self) -> Vec<u8> {
        let v = std::mem::take(&mut self.u16buf);
        let mut out = Vec::with_capacity(v.len() * 2);
        for s in v { out.extend_from_slice(&s.to_le_bytes()); }
        out
    }
    /// RGBA f32 (bit_depth == 32). Returned as Float32Array. Empty otherwise.
    pub fn take_rgba_f32(&mut self) -> Vec<f32> { std::mem::take(&mut self.f32buf) }
    /// Display-ready RGBA8 regardless of source depth (f32 -> linear->sRGB).
    pub fn to_display_rgba8(&self) -> Vec<u8> {
        match self.bit_depth {
            32 => raw_pipeline::image_formats::f32_linear_to_srgb8(&self.f32buf),
            16 => self.u16buf.iter().map(|&s| (s >> 8) as u8).collect(),
            _  => self.u8buf.clone(),
        }
    }
}

fn decoded_to_wasm(d: raw_pipeline::image_formats::DecodedRgba) -> DecodedImage {
    DecodedImage {
        width: d.width, height: d.height, bit_depth: d.bit_depth,
        u8buf: d.u8, u16buf: d.u16, f32buf: d.f32,
    }
}

/// Decode a general RGB(A) TIFF (u8 or u16) to RGBA.
#[wasm_bindgen]
pub fn decode_tiff(bytes: &[u8]) -> Result<DecodedImage, JsValue> {
    raw_pipeline::image_formats::decode_tiff_bytes(bytes)
        .map(decoded_to_wasm)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Decode an OpenEXR image to RGBA f32 (linear HDR preserved).
#[wasm_bindgen]
pub fn decode_exr(bytes: &[u8]) -> Result<DecodedImage, JsValue> {
    raw_pipeline::image_formats::decode_exr_bytes(bytes)
        .map(decoded_to_wasm)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}
```
(If `JsValue` is not already imported in `src/lib.rs`, add `use wasm_bindgen::JsValue;` near the other imports.)

- [ ] **Step 3: Build the wasm package**

Run: `wasm-pack build --target web --out-dir pkg --release`
Expected: PASS; `pkg/raw_converter_wasm.d.ts` now lists `decode_tiff`, `decode_exr`, `DecodedImage`.

- [ ] **Step 4: Commit**
```bash
git add src/lib.rs Cargo.toml pkg
git commit -m "feat(wasm): decode_tiff/decode_exr exports + DecodedImage handle"
```

---

## Task 6: Synthetic Mandelbrot generator (EXR f32 + 16-bit/8-bit TIFF)

**Files:**
- Create: `crates/raw-pipeline/src/bin/gen_fractal.rs`

- [ ] **Step 1: Write the generator (Rust port of generate-fractal-tiff.mjs, high-bit)**

Create `crates/raw-pipeline/src/bin/gen_fractal.rs`:
```rust
//! Generate synthetic Mandelbrot test images at high bit depth.
//! Smooth (continuous) escape-time + a vivid palette with HDR peaks (>1.0) so the
//! f32 path is actually exercised. Outputs to the dir given as argv[1] (default ".").
//!   mandelbrot_f32.exr   (RGBA f32, linear, HDR)
//!   mandelbrot_u16.tiff  (RGB16)
//!   mandelbrot_u8.tiff   (RGB8)

fn smooth_iter(cx: f64, cy: f64, max_iter: u32) -> f64 {
    let (mut x, mut y) = (0.0_f64, 0.0_f64);
    for i in 0..max_iter {
        let (x2, y2) = (x * x, y * y);
        if x2 + y2 > 256.0 {
            let log_zn = (x2 + y2).ln() / 2.0;
            let nu = (log_zn / std::f64::consts::LN_2).ln() / std::f64::consts::LN_2;
            return i as f64 + 1.0 - nu; // continuous escape value
        }
        y = 2.0 * x * y + cy;
        x = x2 - y2 + cx;
    }
    max_iter as f64
}

/// iter -> linear RGB with HDR peaks (channel-separated, non-grey). Inside set = 0.
fn iter_to_linear(iter: f64, max_iter: u32) -> [f32; 3] {
    if iter >= max_iter as f64 { return [0.0, 0.0, 0.0]; }
    let t = (iter / max_iter as f64).clamp(0.0, 1.0) as f32;
    // three phase-shifted sines -> distinct channels; scale to ~[0,3] for HDR.
    let tau = std::f32::consts::TAU;
    let r = 0.5 + 0.5 * (tau * (t * 3.0 + 0.00)).sin();
    let g = 0.5 + 0.5 * (tau * (t * 3.0 + 0.33)).sin();
    let b = 0.5 + 0.5 * (tau * (t * 3.0 + 0.66)).sin();
    let hdr = 1.0 + 2.0 * t; // peak ~3.0 to push past 1.0
    [r * hdr, g * hdr, b * hdr]
}

fn main() {
    let dir = std::env::args().nth(1).unwrap_or_else(|| ".".into());
    let (w, h, max_iter) = (256u32, 256u32, 200u32);
    let (x_min, x_max, y_min, y_max) = (-2.5_f64, 1.0, -1.25, 1.25);

    let mut f32buf = Vec::with_capacity((w * h * 4) as usize);
    for py in 0..h {
        let cy = y_min + (py as f64 / h as f64) * (y_max - y_min);
        for px in 0..w {
            let cx = x_min + (px as f64 / w as f64) * (x_max - x_min);
            let [r, g, b] = iter_to_linear(smooth_iter(cx, cy, max_iter), max_iter);
            f32buf.extend_from_slice(&[r, g, b, 1.0]);
        }
    }

    // EXR f32 (linear, HDR preserved)
    let exr: image::ImageBuffer<image::Rgba<f32>, Vec<f32>> =
        image::ImageBuffer::from_raw(w, h, f32buf.clone()).unwrap();
    image::DynamicImage::ImageRgba32F(exr)
        .save(format!("{dir}/mandelbrot_f32.exr")).unwrap();

    // u16 / u8 TIFF (tone-mapped to display range so they are viewable)
    let disp = raw_pipeline::image_formats::f32_linear_to_srgb8(&f32buf); // RGBA8
    let rgb8: Vec<u8> = disp.chunks_exact(4).flat_map(|p| [p[0], p[1], p[2]]).collect();
    image::RgbImage::from_raw(w, h, rgb8.clone()).unwrap()
        .save(format!("{dir}/mandelbrot_u8.tiff")).unwrap();
    let rgb16: Vec<u16> = rgb8.iter().map(|&b| (b as u16) << 8 | b as u16).collect();
    let img16: image::ImageBuffer<image::Rgb<u16>, Vec<u16>> =
        image::ImageBuffer::from_raw(w, h, rgb16).unwrap();
    image::DynamicImage::ImageRgb16(img16)
        .save(format!("{dir}/mandelbrot_u16.tiff")).unwrap();

    println!("wrote mandelbrot_f32.exr / mandelbrot_u16.tiff / mandelbrot_u8.tiff to {dir}");
}
```

- [ ] **Step 2: Generate the fixtures into the test dir**

Run: `cd crates/raw-pipeline && cargo run --no-default-features --features image-formats --bin gen_fractal -- tests/fixtures`
Expected: prints "wrote ..."; three files appear under `crates/raw-pipeline/tests/fixtures/`.
(Run `mkdir -p crates/raw-pipeline/tests/fixtures` first if needed.)

- [ ] **Step 3: Commit (generator + fixtures)**
```bash
git add crates/raw-pipeline/src/bin/gen_fractal.rs crates/raw-pipeline/tests/fixtures
git commit -m "test(raw-pipeline): synthetic Mandelbrot EXR(f32)+TIFF generator + fixtures"
```

---

## Task 7: Native round-trip test (clean output proof)

**Files:**
- Create: `crates/raw-pipeline/tests/image_formats_roundtrip.rs`

- [ ] **Step 1: Write the round-trip test**

Create `crates/raw-pipeline/tests/image_formats_roundtrip.rs`:
```rust
use raw_pipeline::image_formats::*;

const DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");

#[test]
fn exr_roundtrip_preserves_hdr_and_is_clean() {
    let bytes = std::fs::read(format!("{DIR}/mandelbrot_f32.exr")).unwrap();
    let d = decode_exr_bytes(&bytes).unwrap();
    assert_eq!((d.width, d.height, d.bit_depth), (256, 256, 32));
    // no NaN/Inf anywhere
    assert!(d.f32.iter().all(|v| v.is_finite()), "non-finite sample in EXR decode");
    // HDR actually present (generator peaks ~3.0)
    let max = d.f32.iter().cloned().fold(0.0_f32, f32::max);
    assert!(max > 1.5, "expected HDR values >1.5, got max {max}");
    // display conversion is clean: all bytes valid, alpha solid, not all-black
    let disp = f32_linear_to_srgb8(&d.f32);
    assert_eq!(disp.len(), (256 * 256 * 4) as usize);
    assert!(disp.iter().skip(3).step_by(4).all(|&a| a == 255), "alpha must be opaque");
    assert!(disp.iter().any(|&b| b > 10), "image must not be all-black");
    // channel separation preserved (palette is non-grey): channels differ somewhere
    let differs = disp.chunks_exact(4).any(|p| p[0] != p[1] || p[1] != p[2]);
    assert!(differs, "expected colour, got greyscale");
}

#[test]
fn tiff16_roundtrip_keeps_16bit() {
    let bytes = std::fs::read(format!("{DIR}/mandelbrot_u16.tiff")).unwrap();
    let d = decode_tiff_bytes(&bytes).unwrap();
    assert_eq!((d.width, d.height, d.bit_depth), (256, 256, 16));
    assert_eq!(d.u16.len(), (256 * 256 * 4) as usize);
}

#[test]
fn tiff8_roundtrip() {
    let bytes = std::fs::read(format!("{DIR}/mandelbrot_u8.tiff")).unwrap();
    let d = decode_tiff_bytes(&bytes).unwrap();
    assert_eq!((d.width, d.height, d.bit_depth), (256, 256, 8));
    assert_eq!(d.u8.len(), (256 * 256 * 4) as usize);
}
```

- [ ] **Step 2: Run the round-trip tests**

Run: `cd crates/raw-pipeline && cargo test --no-default-features --features image-formats --test image_formats_roundtrip -- --nocapture`
Expected: PASS (all three).

- [ ] **Step 3: Commit**
```bash
git add crates/raw-pipeline/tests/image_formats_roundtrip.rs
git commit -m "test(raw-pipeline): EXR/TIFF synthetic round-trip (HDR intact, clean output)"
```

---

## Task 8: JS `detectFormat` classifier

**Files:**
- Create: `web/format-detect.js`
- Create: `web/format-detect.test.js`

- [ ] **Step 1: Write the failing test**

Create `web/format-detect.test.js`:
```js
import { test, expect } from 'vitest';
import { detectFormat } from './format-detect.js';

const bytes = (...b) => new Uint8Array(b);

test('magic bytes classify', () => {
  expect(detectFormat(bytes(0x76, 0x2f, 0x31, 0x01), 'x.exr')).toBe('exr');
  expect(detectFormat(bytes(0x49, 0x49, 0x2a, 0x00), 'x.tif')).toBe('tiff');
  expect(detectFormat(bytes(0x89, 0x50, 0x4e, 0x47), 'x.png')).toBe('sdr');
  expect(detectFormat(bytes(0xff, 0xd8, 0xff, 0xe0), 'x.jpg')).toBe('sdr');
  expect(detectFormat(bytes(0x47, 0x49, 0x46, 0x38), 'x.gif')).toBe('sdr');
});

test('RAW tiff containers disambiguate by extension', () => {
  // ORF/DNG/CR2 are TIFF-magic but route to RAW, not the tiff decoder
  expect(detectFormat(bytes(0x49, 0x49, 0x2a, 0x00), 'photo.orf')).toBe('raw');
  expect(detectFormat(bytes(0x49, 0x49, 0x2a, 0x00), 'photo.dng')).toBe('raw');
});

test('avif by ftyp brand', () => {
  const avif = bytes(0,0,0,0x20, 0x66,0x74,0x79,0x70, 0x61,0x76,0x69,0x66);
  expect(detectFormat(avif, 'x.avif')).toBe('sdr');
});

test('unknown', () => {
  expect(detectFormat(bytes(1, 2, 3, 4), 'x.bin')).toBe('unknown');
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run web/format-detect.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `detectFormat`**

Create `web/format-detect.js`:
```js
// Classify an uploaded file into a decode route from its header bytes + name.
// Returns: 'raw' | 'jxl' | 'sdr' | 'tiff' | 'exr' | 'unknown'
//   raw  -> process_orf/dng/cr2     sdr -> createImageBitmap
//   tiff -> wasm decode_tiff        exr -> wasm decode_exr
//   jxl  -> existing jxl path
const RAW_EXT = /\.(orf|dng|cr2|raw|arw|nef|rw2)$/i;

export function detectFormat(bytes, name = '') {
  const b = bytes, n = name.toLowerCase();
  const m = (...s) => s.every((v, i) => b[i] === v);

  if (m(0x76, 0x2f, 0x31, 0x01)) return 'exr';                 // OpenEXR
  if (m(0xff, 0x0a) || n.endsWith('.jxl')) return 'jxl';       // JXL codestream
  if (m(0x00, 0x00, 0x00) && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70)
    return 'sdr';                                              // ISO-BMFF (avif/heic) -> browser
  if (m(0x89, 0x50, 0x4e, 0x47)) return 'sdr';                 // PNG
  if (m(0xff, 0xd8, 0xff)) return 'sdr';                       // JPEG
  if (m(0x47, 0x49, 0x46)) return 'sdr';                       // GIF
  if (m(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45) return 'sdr'; // WEBP (RIFF…WE)
  if (m(0x49, 0x49, 0x2a, 0x00) || m(0x4d, 0x4d, 0x00, 0x2a)) {
    return RAW_EXT.test(n) ? 'raw' : 'tiff';                  // TIFF container
  }
  if (RAW_EXT.test(n)) return 'raw';
  return 'unknown';
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `npx vitest run web/format-detect.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add web/format-detect.js web/format-detect.test.js
git commit -m "feat(web): detectFormat magic-byte classifier for ingestion routing"
```

---

## Task 9: Wire the dispatcher into `processImageFile`

**Files:**
- Modify: `web/jxl-benchmark.js` (the `processImageFile` function, ~lines 745-797; the `accept` string ~line 490)

- [ ] **Step 1: Import the classifier + decoders**

At the top of `web/jxl-benchmark.js`, alongside the existing `process_orf` import, add:
```js
import { detectFormat } from './format-detect.js';
// decode_tiff, decode_exr come from the same wasm module as process_orf:
const { decode_tiff, decode_exr } = rawWasm;
```

- [ ] **Step 2: Widen the accept filter**

Change the `accept` string (~line 490) to:
```js
    accept: '.orf,.ORF,.dng,.cr2,.jpg,.jpeg,.png,.gif,.webp,.avif,.tif,.tiff,.exr,.jxl,image/*',
```

- [ ] **Step 3: Replace the body of `processImageFile` to route via detectFormat**

Replace the `try { ... }` block inside `processImageFile` (the RAW/else-image branch) with:
```js
    try {
        const head = new Uint8Array(arrayBuffer.slice(0, 16));
        const route = detectFormat(head, name);

        if (route === 'raw') {
            if (!wasmReady) { dbgLog('WASM not ready'); return null; }
            const result = process_orf(new Uint8Array(arrayBuffer), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NaN, NaN, 0, 0);
            try {
                return { pixels: result.take_rgb(), format: 'rgb8', width: result.width, height: result.height };
            } finally { result.free(); }
        }

        if (route === 'tiff' || route === 'exr') {
            if (!wasmReady) { dbgLog('WASM not ready'); return null; }
            const u8 = new Uint8Array(arrayBuffer);
            const dec = route === 'exr' ? decode_exr(u8) : decode_tiff(u8);
            try {
                // display path: always present a clean RGBA8 preview regardless of depth
                const pixels = dec.to_display_rgba8();
                return {
                    pixels, format: 'rgba8',
                    width: dec.width, height: dec.height,
                    bitDepth: dec.bit_depth,                 // 8/16/32 retained for the encode path
                };
            } finally { dec.free(); }
        }

        // sdr (png/jpg/gif/webp/avif) + jxl -> browser-native decode
        if (route === 'sdr' || route === 'jxl' || type.startsWith('image/')) {
            const blob = new Blob([arrayBuffer], { type: type || 'application/octet-stream' });
            const bitmap = await createImageBitmap(blob);
            const canvas = document.createElement('canvas');
            canvas.width = bitmap.width; canvas.height = bitmap.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(bitmap, 0, 0);
            const d = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
            return { pixels: new Uint8Array(d.buffer, d.byteOffset, d.byteLength),
                     format: 'rgba8', width: bitmap.width, height: bitmap.height };
        }

        dbgLog(`✗ Unsupported/unknown file: ${name} (${type})`);
    } catch (err) {
        dbgLog(`✗ Process: ${err.message}`);
        console.error('processImageFile error:', err);
    }
    return null;
```

- [ ] **Step 4: Run the existing JS test suite (no regression)**

Run: `npx vitest run web/icodec-jxl-worker.test.js web/jxl-benchmark-progress.test.js`
Expected: PASS (existing ORF path still works through the new dispatcher).

- [ ] **Step 5: Commit**
```bash
git add web/jxl-benchmark.js
git commit -m "feat(web): route uploads via detectFormat (tiff/exr->wasm, sdr->browser)"
```

---

## Task 10: In-browser clean-output proof (Playwright)

**Files:**
- Create: `web/multi-format-roundtrip.test.mjs`

- [ ] **Step 1: Write the browser round-trip test**

Create `web/multi-format-roundtrip.test.mjs`:
```js
import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

const FIX = 'crates/raw-pipeline/tests/fixtures';

test('EXR decodes in-browser to a clean, non-black, opaque image', async ({ page }) => {
  // serve the built wasm page; the project test harness exposes window.N-style globals,
  // here we load the wasm module directly and call decode_exr in-page.
  await page.goto(pathToFileURL(`${process.cwd()}/web/index.html`).href);
  const exr = Array.from(readFileSync(`${FIX}/mandelbrot_f32.exr`));
  const res = await page.evaluate(async (bytes) => {
    const m = await import('./pkg/raw_converter_wasm.js');
    await m.default();
    const dec = m.decode_exr(new Uint8Array(bytes));
    const rgba = dec.to_display_rgba8();
    const w = dec.width, h = dec.height;
    let nonBlack = 0, opaque = 0, coloured = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      if (rgba[i] > 10 || rgba[i+1] > 10 || rgba[i+2] > 10) nonBlack++;
      if (rgba[i+3] === 255) opaque++;
      if (rgba[i] !== rgba[i+1] || rgba[i+1] !== rgba[i+2]) coloured++;
    }
    dec.free();
    return { w, h, bd: dec.bit_depth, nonBlack, opaque, coloured, total: (rgba.length/4) };
  }, exr);
  expect(res.w).toBe(256);
  expect(res.bd).toBe(32);
  expect(res.opaque).toBe(res.total);          // fully opaque
  expect(res.nonBlack).toBeGreaterThan(res.total * 0.3);
  expect(res.coloured).toBeGreaterThan(0);      // colour preserved
});
```

- [ ] **Step 2: Run the browser test**

Run: `npx playwright test web/multi-format-roundtrip.test.mjs`
Expected: PASS. (If the harness needs a static server, serve `web/` first, e.g. `npx http-server web -p 8080` and point `page.goto` at `http://localhost:8080/index.html`.)

- [ ] **Step 3: Commit**
```bash
git add web/multi-format-roundtrip.test.mjs
git commit -m "test(web): in-browser EXR clean-output round-trip (Playwright)"
```

---

## Final verification

- [ ] **Full native test:** `cd crates/raw-pipeline && cargo test --no-default-features --features image-formats` → all green.
- [ ] **Full wasm build:** `wasm-pack build --target web --out-dir pkg --release` → PASS.
- [ ] **JS unit tests:** `npx vitest run web/format-detect.test.js` → PASS.
- [ ] **Manual smoke:** open the benchmark page, drop a PNG, a 16-bit TIFF, and the synthetic EXR — each previews cleanly.

## Spec coverage map

- PNG/JPEG/GIF/WebP/AVIF upload → Tasks 8, 9 (browser-native route).
- TIFF (u8/u16) → Tasks 2, 3, 5, 9.
- EXR (f32, HDR preserved) → Tasks 1, 3, 5, 9.
- f32 pipeline ingress / display → Tasks 4, 5 (`to_display_rgba8`).
- Synthetic Mandelbrot, clean round-trip → Tasks 6, 7, 10.
- Browser-only constraint → Task 1 (wasm build gates), Task 5.
- No regression to RAW/JXL → Task 9 Step 4.
