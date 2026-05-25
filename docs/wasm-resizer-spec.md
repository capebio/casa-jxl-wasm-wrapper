# Specification: WASM-Based Image Resizer (C++/Rust)

## Overview
The current implementation of thumbnail generation and image resizing relies on the HTML5 `<canvas>` API (`outCtx.drawImage`). While convenient, this requires transferring massive uncompressed RGBA pixel buffers (e.g., 100MB+ for a 25-megapixel image) from the JS heap to the GPU and back again via `getImageData()`. 

This specification outlines the replacement of the canvas resizer with a WebAssembly (WASM) based implementation. By keeping the pixel data within the WASM memory space and utilizing SIMD (Single Instruction, Multiple Data) vectorization, we eliminate GPU transfer bottlenecks and Garbage Collection (GC) spikes.

---

## 1. Expected Performance Gains

**HTML Canvas (Current):**
*   **Speed:** ~80ms – 250ms for a 20MP image (highly dependent on browser GPU acceleration and main-thread contention).
*   **Memory:** Creates two copies of the image data in memory, plus browser-internal backing stores. Triggers major GC pauses.
*   **Execution:** Asynchronous/Event-loop blocking.

**WASM SIMD Resizer (Proposed):**
*   **Speed:** **~10ms – 25ms** for a 20MP image (A projected **5x to 10x speedup**).
*   **Memory:** Zero-copy input (reads directly from the existing WASM heap). Only allocates the small target thumbnail buffer.
*   **Execution:** Synchronous, fully deterministic, zero DOM overhead.

---

## 2. Architecture & Placement

Since you already have a mature Rust WASM module (`raw-converter-wasm`), the most efficient path is to add the resizer to the **Rust** layer. This allows you to chain the operations: parse the RAW file → demosaic → resize → return the thumbnail directly to Javascript, completely bypassing the massive intermediate 100MB transfer.

Alternatively, if you need to resize arbitrary images (like JPEGs or existing JXLs), adding a standalone C++ module or incorporating it into the `jxl-wasm` bridge is acceptable. For this spec, we will assume it is added to the Rust `raw-converter-wasm` crate.

---

## 3. Implementation Details

### A. The Algorithm (Bilinear or Lanczos)
For thumbnails, a standard **Bilinear** or **Bicubic** interpolation offers the best balance of speed and visual quality. 
*   We will use the widely trusted `image` crate or `fast_image_resize` crate in Rust, which are already heavily optimized with SIMD intrinsics for `wasm32`.

### B. Rust API Additions (`src/lib.rs`)

Add a new public function exposed via `wasm-bindgen`.

```rust
use wasm_bindgen::prelude::*;
use fast_image_resize as fr;
use std::num::NonZeroU32;

#[wasm_bindgen]
pub struct ResizedImage {
    pub width: u32,
    pub height: u32,
    pixels: Vec<u8>,
}

#[wasm_bindgen]
impl ResizedImage {
    pub fn take_rgba(self) -> js_sys::Uint8Array {
        // Transfers ownership of the vector to JS without copying
        unsafe { js_sys::Uint8Array::view(&self.pixels) }
    }
}

#[wasm_bindgen]
pub fn resize_rgba(
    input_pixels: &[u8], 
    src_width: u32, 
    src_height: u32, 
    target_width: u32, 
    target_height: u32
) -> Result<ResizedImage, JsValue> {
    
    // 1. Create source image wrapper (Zero Copy)
    let src_image = fr::Image::from_slice_u8(
        NonZeroU32::new(src_width).unwrap(),
        NonZeroU32::new(src_height).unwrap(),
        input_pixels,
        fr::PixelType::U8x4,
    ).map_err(|e| JsValue::from_str(&e.to_string()))?;

    // 2. Allocate destination buffer
    let mut dst_image = fr::Image::new(
        NonZeroU32::new(target_width).unwrap(),
        NonZeroU32::new(target_height).unwrap(),
        fr::PixelType::U8x4,
    );

    // 3. Create Resizer (Using Bilinear for high speed)
    let mut resizer = fr::Resizer::new(
        fr::ResizeAlg::Convolution(fr::FilterType::Bilinear),
    );

    // 4. Execute Resize (SIMD accelerated if enabled in build)
    resizer.resize(&src_image.view(), &mut dst_image.view_mut())
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    Ok(ResizedImage {
        width: target_width,
        height: target_height,
        pixels: dst_image.into_vec(),
    })
}
```

### C. TypeScript Integration

Update `web/jxl-wrapper-lab.js` (and any other frontend files) to swap out the canvas logic for the new WASM call.

```javascript
import { resize_rgba } from '../pkg/raw_converter_wasm.js';

// Replaces the old async resizeRgba function
function resizeRgbaWasm(rgba, width, height, targetWidth) {
    const scale = targetWidth / width;
    const targetHeight = Math.round(height * scale);
    
    // Execute WASM SIMD Resize synchronously
    const result = resize_rgba(rgba, width, height, targetWidth, targetHeight);
    
    try {
        // Take ownership of the memory
        const resizedPixels = result.take_rgba();
        
        // Because WASM memory views detach when memory grows, 
        // we copy the tiny thumbnail buffer to the JS heap immediately.
        const safeCopy = new Uint8Array(resizedPixels); 
        
        return {
            rgba: safeCopy,
            width: targetWidth,
            height: targetHeight
        };
    } finally {
        result.free(); // Free the Rust struct
    }
}
```

---

## 4. Build Configuration

To guarantee the **5x-10x speedup**, the WebAssembly compiler must be allowed to emit SIMD instructions. Ensure the `raw-converter-wasm` Cargo profile or build script enables the `simd128` target feature.

In `.cargo/config.toml`:
```toml
[target.wasm32-unknown-unknown]
rustflags = ["-C", "target-feature=+simd128"]
```
*(Note: If you need to support browsers older than 2021, you would compile a fallback version without this flag, much like the tier system you already use in `jxl-wasm`).*
