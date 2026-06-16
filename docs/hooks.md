# hooks.md — Hooking into Perceptual Constancy Mode

## What the Feature Is/Does (Summary)
Perceptual Constancy Mode enables the advanced perceptual color engine (sensor-sharpen B matrix + log-transform for flat Euclidean space from Schrödinger geodesics; Molchanov A_tensor/residuals for adaptive grid and uniform sliders; hybrid ΔE spring + Los Alamos f(c) for drift-free, hue-calibrated adjustments) directly in the hot per-pixel `apply_tone_math` loop of the LookRenderer (`crates/raw-pipeline/src/pipeline.rs`).

It delivers illumination-invariant exposure, saturation, and white-balance changes during progressive JXL paints (and raw pipelines). This supports:
- AR real-time plant ID (consistent recognition across lighting).
- Photogrammetry/digital twins (metric color for accurate 3D from images).
- LLM/machine recognition (reliable features on early progressive frames).
- Immersive experiences (foveated/attended adjustments via lightbox focusRegion + getAttended).

See `/docs/PerceptualConstancyMode.md` for full math, benefits, and implementation details. It is **runtime-only** (for paints/adjustments in lightbox/gallery; never baked into final JXL ingest per project invariants).

## How to Hook Into It

### 1. Rust / Native / WASM Side (Core Engine)
The primary hook is `PipelineParams.perceptual_constancy: bool`.

```rust
use raw_pipeline::pipeline::{PipelineParams, process, process_rgba, process_16bit};

// Minimal example (after demosaic or from JXL decode pixels as rgb16)
let params = PipelineParams {
    black: 0,
    white: 16383,
    wb_r: 2.0,
    wb_g: 1.0,
    wb_b: 1.7,
    exposure_ev: 0.5,      // example adjustment
    saturation: 0.2,
    vibrance: 0.1,
    // ... other tone params (contrast, shadows, etc.)
    color_matrix: None,    // or provide camera-to-sRGB
    perceptual_constancy: true,  // <--- THE HOOK: enables advanced Lens17 path
    texture: 0.0,
    clarity: 0.0,
    // ... other fields as needed (see struct)
};

// Choose output flavor
let rgb8 = process(&rgb16_input, &params);        // -> Vec<u8> RGB8 (sRGB gamma)
let rgba8 = process_rgba(&rgb16_input, &params);  // -> Vec<u8> RGBA8 (A=255)
let rgb16_out = process_16bit(&rgb16_input, &params); // -> Vec<u16> linear-ish 16-bit

// For LookRenderer-style incremental use, derive_tone_inputs + apply_tone_math
// can be called directly if you manage LUTs yourself (see LutCache thread_local).
```

- When `true`: enters the log-space foundation (currently stub for sat; evolves to full B + tensor + residuals + spring + f(c)).
- When `false` (default): baseline tone math only (faster, no advanced invariance).
- The flag flows through `derive_tone_inputs` → `ToneInputs` → every call to `apply_tone_math` inside the process loops (scalar or parallel via rayon).
- Pre-LUT (build_pre_lut for black/white/WB/exposure) and post-LUT (tone_curve + sRGB) still apply; the constancy math sits in the middle for the "flat" perceptual adjustments.
- Thread-local `LUT_CACHE` ensures the expensive 64k LUTs are built once per (params) combination.

**Performance note**: The new path adds ln/exp cost per pixel. See flip-flop tests in `pipeline.rs` (tonemap_flip_flops) for quantifying "new" vs "old" on your buffers. Mitigations (pointer moves in loops — already applied; SIMD on apply_tone_math; C++ port of the kernel; LUT accel) are in progress / suggested via the lenses.

**Integration points in raw pipeline**:
- Called from dng/cr2 decode paths after demosaic (when producing DngDemosaiced or via full process).
- Exposed publicly via the three process fns.
- For pure JXL (no raw), the engine is intended to be called post-decode on pixel buffers (future WASM export or via the JS hook below feeding into Rust).

### 2. JavaScript / Web / Lightbox Side (for Progressive JXL Paints)
The web lightbox/gallery already has a client-side hook surface for constancy params. This can drive the Rust engine (or apply approximations client-side until full LUT/WASM exposure).

From `web/jxl-progressive-gallery-lightbox.js` and wired in `web/jxl-progressive-gallery.js`:

```js
const lightbox = createGalleryLightbox({ framesByFile });

// Set the mode + adjustments (called from UI sliders, AR gaze, etc.)
lightbox.setConstancyParams({
  mode: 'constancy',      // or 'off'
  exposure: 0.5,          // EV-like
  saturation: 0.2,
  whiteBalance: [1.1, 1.0, 0.95]  // r/g/b multipliers
});

// Optional: foveated/AR focus (ties into priorityTargets from coordinator)
lightbox.setFocusRegion({ x: 100, y: 200, w: 300, h: 300 });

// During paint (in drawFrameToCanvas / packFramePixels)
const params = lightbox.getConstancyParams();  // or lightbox.getAttended() for full context
drawFrameToCanvas(canvas, frame, params);  // passes through to packFramePixels(frame, { constancyParams: params })

// For LLM/AR consumers
const attended = lightbox.getAttended();  // { fileId, frameIndex, constancyParams, focusRegion }
```

**How it flows today**:
- `setConstancyParams` updates internal state.
- On render (thumb strips or lightbox canvas): `renderLightboxState` → `drawFrameToCanvas(canvas, frame, params)` → `packFramePixels(frame, { constancyParams })`.
- `packFramePixels` (in `web/jxl-progressive-gallery-frame.js`) has the hook: `if (constancyParams && constancyParams.mode === 'constancy') { /* apply or forward */ }`. Currently a no-op stub (pass-through); real math will call into WASM Rust LookRenderer / apply_tone_math when exposed.
- `getAttended()` + coordinator `getPriorityTargets()` give the surface for "focus this asset/region with constancy on" (AR gaze, LLM on attended frame).

**Wiring to Rust engine (future/current hybrid)**:
- For raw-pipeline users: pass `perceptual_constancy: true` + params directly (see Rust section).
- For JXL progressive: the JS params (exposure/sat/wb/mode) are the "user intent". In a full integration, forward them to a WASM-exported tone function (or apply post-decode in pack using a WASM LUT built from the same math).
- Example bridge (in a future WASM facade or via existing jxl-wasm):
  ```js
  // After decode produces pixels
  if (constancyParams.mode === 'constancy') {
    const adjusted = wasmLookRenderer.applyConstancy(pixels, width, height, constancyParams);
    // or pack with the params and let Rust tone do it upstream
  }
  ```
- See `web/jxl-progressive-gallery.js` (wires set + passes to draw on progressive frames) and lightbox for the full surface.

**Other hooks**:
- In `PipelineParams.default_olympus()` (baseline) — override `perceptual_constancy`.
- Thread-local cache means you can "prime" by calling process once with desired params.
- For AR/LLM: combine with `getAttended()` + focusRegion to drive selective application (only on attended plant, not whole grid).
- Preset side (best-preset etc.): future presets can carry `perceptualConstancy: true` and wire to decode/encode options.

### 3. Testing / Diagnostics
- Flip-flop tests (in `pipeline.rs` under `tonemap_flip_flops` and dng tests): alternate `perceptual_constancy` (or equivalent demosaic/black switches) 10× on the same buffer/asset. Use to validate "new" (with advanced math) vs "old" timings and correctness.
  ```bash
  cargo test --manifest-path crates/raw-pipeline/Cargo.toml --no-default-features --features parallel --lib tonemap_flip_flops -- --nocapture
  ```
- StandardMultifileTest.mjs for end-to-end raw decode + tone timings (watch raw_tonemap_ms when the mode is active).
- The mode is "reassessed positive" for the vision; mitigations (SIMD in apply_tone_math, C++ port of the kernel, pointer moves in loops — already partially applied, LUT acceleration) keep it usable in real-time progressive/AR flows.

### Gotchas / Invariants
- Never bake the adjustments into final JXL (runtime paint only).
- Keep the stub/non-Riemannian path behind the flag so baseline performance is unaffected.
- When evolving the math (add real B matrix, A_tensor modulation, full residuals, f(c)), keep it inside `apply_tone_math` as the "one place".
- JS hook (constancyParams) is the extensibility surface for lightbox/AR; Rust params is the execution engine.

This gives a clean, hookable path from high-level UI/AR intent all the way to the per-pixel math without violating existing progressive checkpoint or scheduler invariants.

# End of hooks.md
