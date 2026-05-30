# JXL Preset Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add CR2 WASM export, wire brotliEffort + modular into wrapper-lab, and build `jxl-preset-benchmark.html` — a phased automated sweep page that derives Low/Medium/High/Lossless presets from real encode/decode timings across ORF, DNG, CR2, and JPEG files.

**Architecture:** Three independent parts shipped in sequence: (1) CR2 WASM export in `src/lib.rs` mirrors the DNG pattern exactly; (2) two new controls in `jxl-wrapper-lab` expose `modular` and `brotliEffort` through the existing encode path; (3) a new standalone page `jxl-preset-benchmark.html` + `.js` + `.css` runs a four-phase sweep, persists files in IndexedDB, graphs results with Chart.js, and emits copyable preset JSON.

**Tech Stack:** Rust/wasm-bindgen (CR2 export), vanilla JS ES modules, IndexedDB, Chart.js 4.4.1 (already on CDN in jxl-benchmark.html), existing `jxl-debug-console.js`, `@casabio/jxl-wasm` facade.

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `src/lib.rs` | Add `Cr2Decoded`, `decode_cr2_raw`, `process_cr2_impl`, `process_cr2`, `process_cr2_with_flags` |
| Modify | `web/jxl-wrapper-lab.html` | Add modular + brotliEffort controls; add `.cr2` to accept |
| Modify | `web/jxl-wrapper-lab.js` | Add `getModular`, `getBrotliEffort`, update `makeEncoderOptions`, add CR2 decode path |
| Create | `web/jxl-preset-benchmark.html` | Page shell, nav, importmap, Chart.js script tags |
| Create | `web/jxl-preset-benchmark.js` | IDB helpers, file intake, sweep engine, charts, results table, presets |
| Create | `web/jxl-preset-benchmark.css` | Page-specific styles |
| Modify | All nav bars | Add "Preset benchmark" link |

---

## Task 1: CR2 WASM export in `src/lib.rs`

**Files:**
- Modify: `src/lib.rs` (append after line 1437 — end of `process_dng_with_flags`)

- [ ] **Step 1.1: Add `Cr2Decoded` struct and `decode_cr2_raw` after `process_dng_with_flags` (line 1437)**

Append to `src/lib.rs`:

```rust
// ─── CR2 pipeline ─────────────────────────────────────────────────────────────

struct Cr2Decoded {
    rgb16: Vec<u16>,
    aw: usize,
    ah: usize,
    params: pipeline::PipelineParams,
    color_matrix_flat: [f32; 9],
    decode_ms: f64,
    demosaic_ms: f64,
    orientation: u16,
    make: String,
    model: String,
    iso: u32,
}

/// Shared CR2 decode path: decode bytes → validate → demosaic (always RGGB) → NR → WB setup.
/// Returns pre-tonemapped RGB16 and all metadata.  Called by process_cr2_impl.
fn decode_cr2_raw(data: &[u8]) -> Result<Cr2Decoded, JsError> {
    const MAX_DIM: u32 = 8192;
    const MAX_PIXELS: usize = 50_000_000;

    let t = now_ms();
    let cr2 = raw_pipeline::cr2::decode_bytes(data)
        .map_err(|e| JsError::new(&format!("CR2 decode: {}", e)))?;
    let decode_ms = now_ms() - t;

    let w = cr2.width;
    let h = cr2.height;
    if w == 0 || h == 0 {
        return Err(JsError::new("CR2: zero image dimension"));
    }
    if (w as u32) > MAX_DIM || (h as u32) > MAX_DIM {
        return Err(JsError::new(&format!(
            "CR2: dimension {}×{} exceeds maximum {}",
            w, h, MAX_DIM
        )));
    }
    if w.checked_mul(h).unwrap_or(MAX_PIXELS + 1) > MAX_PIXELS {
        return Err(JsError::new(&format!(
            "CR2: {} pixels exceeds 50 MP limit",
            w * h
        )));
    }

    // CR2 is always RGGB — no align_to_rggb step.
    let t = now_ms();
    let mut rgb16 = demosaic::demosaic_rggb_mhc(&cr2.raw, w, h)
        .map_err(|e| JsError::new(&format!("CR2 demosaic: {}", e)))?;
    let demosaic_ms = now_ms() - t;

    let mut params = pipeline::PipelineParams::default_olympus();
    params.black = cr2.black;
    params.white = cr2.white;
    params.wb_r = cr2.wb_r;
    params.wb_b = cr2.wb_b;
    params.color_matrix = cr2.color_matrix;
    let color_matrix_flat: [f32; 9] = {
        let m = params.color_matrix.unwrap_or(pipeline::CAM_TO_SRGB);
        [m[0][0], m[0][1], m[0][2], m[1][0], m[1][1], m[1][2], m[2][0], m[2][1], m[2][2]]
    };

    let iso = cr2.iso.unwrap_or(100);
    let nr_strength = match iso {
        iso if iso >= 6400 => 0.50f32,
        iso if iso >= 3200 => 0.35,
        iso if iso >= 1600 => 0.20,
        _ => 0.0,
    };
    if nr_strength > 0.0 {
        pipeline::apply_luminance_nr(&mut rgb16, w, h, nr_strength);
    }

    Ok(Cr2Decoded {
        rgb16,
        aw: w,
        ah: h,
        params,
        color_matrix_flat,
        decode_ms,
        demosaic_ms,
        orientation: cr2.orientation,
        make: cr2.make,
        model: cr2.model,
        iso,
    })
}

/// Shared CR2 output stage. Delegates to process_dng_impl via field-compatible DngDecoded.
fn process_cr2_impl(
    decoded: Cr2Decoded,
    output_flags: u32,
    look: &LookOverrides,
) -> Result<ProcessResult, JsError> {
    process_dng_impl(
        DngDecoded {
            rgb16: decoded.rgb16,
            aw: decoded.aw,
            ah: decoded.ah,
            params: decoded.params,
            color_matrix_flat: decoded.color_matrix_flat,
            decode_ms: decoded.decode_ms,
            demosaic_ms: decoded.demosaic_ms,
            orientation: decoded.orientation,
            make: decoded.make,
            model: decoded.model,
            iso: decoded.iso,
        },
        output_flags,
        look,
    )
}

/// Parse + decode a Canon CR2 file blob.
///
/// Always generates full RGB8, 1800 px lightbox RGB16, and 360 px thumbnail RGB16.
/// Use `process_cr2_with_flags` to skip unused outputs.
#[wasm_bindgen]
pub fn process_cr2(
    data: &[u8],
    exposure_ev: f32,
    contrast: f32,
    highlights: f32,
    shadows: f32,
    whites: f32,
    blacks: f32,
    saturation: f32,
    vibrance: f32,
    temp: f32,
    tint: f32,
    wb_r_override: f32,
    wb_b_override: f32,
    texture: f32,
    clarity: f32,
) -> Result<ProcessResult, JsError> {
    let look = LookOverrides {
        wb_r: wb_r_override,
        wb_b: wb_b_override,
        exposure_ev,
        contrast,
        highlights,
        shadows,
        whites,
        blacks,
        saturation,
        vibrance,
        temp,
        tint,
        texture,
        clarity,
    };
    process_cr2_impl(
        decode_cr2_raw(data)?,
        OUT_FULL_RGB8 | OUT_LIGHTBOX | OUT_THUMB,
        &look,
    )
}

/// Variant of `process_cr2` with explicit output flags.
///
/// `output_flags` bitmask: 1 = full RGB8, 2 = 1800 px lightbox RGB16, 4 = 360 px thumb RGB16.
/// Pass `7` to match `process_cr2`.
#[wasm_bindgen]
pub fn process_cr2_with_flags(
    data: &[u8],
    output_flags: u32,
    exposure_ev: f32,
    contrast: f32,
    highlights: f32,
    shadows: f32,
    whites: f32,
    blacks: f32,
    saturation: f32,
    vibrance: f32,
    temp: f32,
    tint: f32,
    wb_r_override: f32,
    wb_b_override: f32,
    texture: f32,
    clarity: f32,
) -> Result<ProcessResult, JsError> {
    let look = LookOverrides {
        wb_r: wb_r_override,
        wb_b: wb_b_override,
        exposure_ev,
        contrast,
        highlights,
        shadows,
        whites,
        blacks,
        saturation,
        vibrance,
        temp,
        tint,
        texture,
        clarity,
    };
    process_cr2_impl(decode_cr2_raw(data)?, output_flags, &look)
}
```

- [ ] **Step 1.2: Build and verify**

```powershell
wasm-pack build --target web --out-dir pkg --release
```

Expected: build succeeds, `pkg/raw_converter_wasm.js` updated.
Check: `grep "process_cr2" pkg/raw_converter_wasm.js` should return matches.

- [ ] **Step 1.3: Smoke-test in browser**

Open `web/index.html` via dev server. Open browser console and run:
```js
import init, { process_cr2 } from '/pkg/raw_converter_wasm.js';
await init();
console.log(typeof process_cr2); // "function"
```

- [ ] **Step 1.4: Commit**

```bash
git add src/lib.rs pkg/
git commit -m "feat(wasm): add process_cr2 + process_cr2_with_flags WASM exports"
```

---

## Task 2: Wrapper-lab — modular + brotliEffort controls

**Files:**
- Modify: `web/jxl-wrapper-lab.html` lines 115–125 (after resampling spin-group, before decode-speed)
- Modify: `web/jxl-wrapper-lab.js` lines 34–40 (new DOM refs), 346–396 (new getters), 900–923 (makeEncoderOptions)

- [ ] **Step 2.1: Add modular radio chips to `jxl-wrapper-lab.html`**

Insert after the closing `</div>` of the resampling `spin-group` (after line 115):

```html
                    <div class="spin-group">
                        <span class="spin-label" style="display:inline-flex;align-items:center;gap:4px;">Modular mode <button class="info-btn" type="button" data-help-target="wl-modular" aria-label="Modular mode info">i</button></span>
                        <div class="preset-group" role="radiogroup" aria-label="JXL modular mode">
                            <label class="chip-label"><input type="radio" name="batch-modular" value="-1" checked /> <span>Auto</span></label>
                            <label class="chip-label"><input type="radio" name="batch-modular" value="0" /> <span>VarDCT</span></label>
                            <label class="chip-label"><input type="radio" name="batch-modular" value="1" /> <span>Modular</span></label>
                        </div>
                        <div class="help-popover" data-help-popover="wl-modular" hidden>
                            Codec selection. Auto lets libjxl choose (VarDCT for photos, Modular for lossless). VarDCT (0) is optimal for photographs at lossy quality. Modular (1) suits lossless and line art.
                        </div>
                    </div>
```

- [ ] **Step 2.2: Add brotliEffort spinner to `jxl-wrapper-lab.html`**

Insert directly after the modular spin-group from Step 2.1:

```html
                    <div class="spin-group">
                        <span class="spin-label" style="display:inline-flex;align-items:center;gap:4px;">Brotli effort <button class="info-btn" type="button" data-help-target="wl-brotli-effort" aria-label="Brotli effort info">i</button></span>
                        <div class="spinpicker">
                            <button class="spin-btn spin-dec" type="button" data-target="batch-brotli-effort">&#8722;</button>
                            <input id="batch-brotli-effort" type="number" min="-1" max="11" step="1" value="-1" />
                            <button class="spin-btn spin-inc" type="button" data-target="batch-brotli-effort">+</button>
                        </div>
                        <div class="help-popover" data-help-popover="wl-brotli-effort" hidden>
                            Brotli entropy effort for metadata boxes (&#8722;1&#8211;11). &#8722;1 = libjxl default. Higher compresses metadata more at encode-time cost. Rarely changes file size significantly for photographic content.
                        </div>
                    </div>
```

- [ ] **Step 2.3: Add new DOM refs in `jxl-wrapper-lab.js`**

After line 40 (`const batchThumbSizeInputs`), add:

```js
const batchModularInputs = [...document.querySelectorAll('input[name="batch-modular"]')];
const batchBrotliEffortInput = document.getElementById('batch-brotli-effort');
```

- [ ] **Step 2.4: Add `getModular` and `getBrotliEffort` in `jxl-wrapper-lab.js`**

After the `getResampling()` function (around line 368), add:

```js
function getModular() {
    const v = Number(batchModularInputs.find(i => i.checked)?.value ?? -1);
    return (v === -1 || v === 0 || v === 1) ? v : -1;
}

function getBrotliEffort() {
    if (!batchBrotliEffortInput) return -1;
    const v = Math.round(Number(batchBrotliEffortInput.value) || -1);
    return Math.max(-1, Math.min(11, v));
}
```

- [ ] **Step 2.5: Update `makeEncoderOptions` in `jxl-wrapper-lab.js`**

Replace the existing `makeEncoderOptions` function (lines 900–923) with:

```js
function makeEncoderOptions(source) {
    const lossless = getLossless();
    const compressBoxes = getCompressBoxes();
    const forceContainer = getForceContainer();
    const rawCodestream = getRawCodestream();
    const hasMetadataOpts = compressBoxes || forceContainer || rawCodestream;
    const modular = getModular();
    const brotliEffort = getBrotliEffort();
    return {
        format: 'rgba8',
        width: source.width,
        height: source.height,
        hasAlpha: true,
        distance: lossless ? 0 : null,
        quality: lossless ? null : getQuality(),
        effort: getEffort(),
        progressive: false,
        previewFirst: false,
        chunked: false,
        decodingSpeed: getDecodeSpeed(),
        photonNoiseIso: getPhotonNoiseIso() > 0 ? getPhotonNoiseIso() : undefined,
        resampling: getResampling(),
        modular: modular !== -1 ? modular : undefined,
        brotliEffort: brotliEffort >= 0 ? brotliEffort : undefined,
        metadata: hasMetadataOpts ? { compressBoxes, forceContainer, rawCodestream } : undefined,
        alphaDistance: getAlphaDistance(),
    };
}
```

- [ ] **Step 2.6: Wire new inputs into `syncSettingLabels` in `jxl-wrapper-lab.js`**

In `wireControls()`, after the existing `batchResamplingInputs` listener (around line 1412), add:

```js
    for (const input of batchModularInputs) input.addEventListener('change', syncSettingLabels);
    batchBrotliEffortInput?.addEventListener('input', syncSettingLabels);
```

- [ ] **Step 2.7: Verify in browser**

Open wrapper-lab. Confirm two new controls appear. Set Modular=VarDCT, BrotliEffort=4, run a batch. In Console, confirm `makeEncoderOptions` output includes `modular: 0` and `brotliEffort: 4`. (Add a temporary `console.log(makeEncoderOptions(encodeSource))` before the encoder call, check, then remove it.)

- [ ] **Step 2.8: Commit**

```bash
git add web/jxl-wrapper-lab.html web/jxl-wrapper-lab.js
git commit -m "feat(wrapper-lab): add modular mode + brotliEffort controls"
```

---

## Task 3: Wrapper-lab — CR2 file handling

**Files:**
- Modify: `web/jxl-wrapper-lab.html` line 212 (file input accept attr + label text)
- Modify: `web/jxl-wrapper-lab.js` lines 1–11 (imports), 682–716 (loadFileSource), 747–789 (loadBytesSourceByName)

- [ ] **Step 3.1: Update file input in `jxl-wrapper-lab.html`**

Replace line 212:
```html
                <input id="source-input" type="file" multiple webkitdirectory accept=".orf,.ORF,.jpg,.jpeg,.png,.tif,.tiff,.jxl,image/*" hidden />
                <strong>Pick files</strong>
                <span>ORF, JPEG, PNG, TIFF, JXL</span>
```
With:
```html
                <input id="source-input" type="file" multiple webkitdirectory accept=".orf,.ORF,.cr2,.CR2,.dng,.DNG,.jpg,.jpeg,.png,.tif,.tiff,.jxl,image/*" hidden />
                <strong>Pick files</strong>
                <span>ORF, CR2, DNG, JPEG, PNG, TIFF, JXL</span>
```

- [ ] **Step 3.2: Import `process_cr2` in `jxl-wrapper-lab.js`**

Replace line 11:
```js
const { process_orf, rgb_to_rgba } = rawWasm;
```
With:
```js
const { process_orf, process_cr2, process_dng, rgb_to_rgba } = rawWasm;
```

- [ ] **Step 3.3: Add CR2/DNG branch in `loadFileSource`**

In `loadFileSource` (around line 682), after the `if (ext === 'jxl')` block and before the `createImageBitmap` fallback, add:

```js
    if (ext === 'cr2') {
        const raw = new Uint8Array(await file.arrayBuffer());
        const source = loadRawBytesAsSource(raw, file.name, '', `${fmtBytes(file.size)}`, process_cr2);
        source.loadMs = performance.now() - started;
        return source;
    }

    if (ext === 'dng') {
        const raw = new Uint8Array(await file.arrayBuffer());
        const source = loadRawBytesAsSource(raw, file.name, '', `${fmtBytes(file.size)}`, process_dng);
        source.loadMs = performance.now() - started;
        return source;
    }
```

- [ ] **Step 3.4: Add `loadRawBytesAsSource` helper in `jxl-wrapper-lab.js`**

Add this function directly before `loadBytesAsSource` (around line 791):

```js
function loadRawBytesAsSource(bytes, name, folder = '', sizeLabel = '', processFn) {
    const started = performance.now();
    const result = processFn(bytes, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NaN, NaN, 0, 0);
    try {
        const rgb = result.take_rgb();
        return {
            name,
            label: `${name} · ${result.width}×${result.height}`,
            meta: [folder, sizeLabel].filter(Boolean).join(' · '),
            width: result.width,
            height: result.height,
            rgba: rgb_to_rgba(rgb),
            loadMs: performance.now() - started,
        };
    } finally {
        result.free();
    }
}
```

- [ ] **Step 3.5: Add CR2/DNG branch in `loadBytesSourceByName`**

In `loadBytesSourceByName` (around line 747), after the `if (ext === 'jxl')` block, add:

```js
    if (ext === 'cr2') {
        const source = loadRawBytesAsSource(bytes, name, folder, sizeLabel || fmtBytes(bytes.byteLength), process_cr2);
        source.loadMs = performance.now() - started;
        return source;
    }
    if (ext === 'dng') {
        const source = loadRawBytesAsSource(bytes, name, folder, sizeLabel || fmtBytes(bytes.byteLength), process_dng);
        source.loadMs = performance.now() - started;
        return source;
    }
```

- [ ] **Step 3.6: Verify CR2 loads in wrapper-lab**

Open wrapper-lab in browser. Drop `C:\Foo\raw-converter\tests\ADH 1234.CR2`. Confirm: tile appears with dimensions shown, no error chip.

- [ ] **Step 3.7: Commit**

```bash
git add web/jxl-wrapper-lab.html web/jxl-wrapper-lab.js
git commit -m "feat(wrapper-lab): add CR2 + DNG file loading support"
```

---

## Task 4: Preset benchmark — HTML shell + CSS

**Files:**
- Create: `web/jxl-preset-benchmark.html`
- Create: `web/jxl-preset-benchmark.css`

- [ ] **Step 4.1: Create `web/jxl-preset-benchmark.css`**

```css
/* jxl-preset-benchmark.css */

.bench-intake {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 10px;
    padding: 14px 16px;
    background: var(--color-surface-2, #0f172a);
    border-bottom: 1px solid var(--color-border, #1e293b);
}

.bench-slot {
    border: 1px dashed var(--slot-color, #475569);
    border-radius: 8px;
    padding: 10px 8px;
    text-align: center;
    cursor: pointer;
    transition: background 0.15s, border-style 0.15s;
    position: relative;
    min-height: 72px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
}
.bench-slot.has-file { border-style: solid; }
.bench-slot.is-drag-over { background: color-mix(in srgb, var(--slot-color) 12%, transparent); }
.bench-slot--orf  { --slot-color: #4ade80; }
.bench-slot--dng  { --slot-color: #60a5fa; }
.bench-slot--cr2  { --slot-color: #f97316; }
.bench-slot--jpeg { --slot-color: #a78bfa; }
.bench-slot--other{ --slot-color: #64748b; }

.bench-slot-type {
    font-weight: 700;
    font-size: 0.85rem;
    color: var(--slot-color);
}
.bench-slot-hint {
    font-size: 0.65rem;
    color: var(--color-fg-muted, #64748b);
}
.bench-slot-filename {
    font-size: 0.62rem;
    background: color-mix(in srgb, var(--slot-color) 15%, transparent);
    color: var(--slot-color);
    border-radius: 3px;
    padding: 2px 5px;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.bench-settings {
    display: flex;
    flex-wrap: wrap;
    gap: 20px;
    align-items: center;
    padding: 12px 16px;
    border-bottom: 1px solid var(--color-border, #1e293b);
}
.bench-settings-group { display: flex; flex-direction: column; gap: 4px; }
.bench-settings-label { font-size: 0.65rem; color: var(--color-fg-muted, #64748b); text-transform: uppercase; letter-spacing: .06em; }
.bench-settings-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.bench-chip-check { display: none; }
.bench-chip-label {
    font-size: 0.75rem;
    padding: 3px 10px;
    border-radius: 4px;
    background: var(--color-surface-2, #0f172a);
    border: 1px solid var(--color-border, #1e293b);
    color: var(--color-fg-muted, #94a3b8);
    cursor: pointer;
    user-select: none;
    transition: background 0.1s, color 0.1s, border-color 0.1s;
}
.bench-chip-check:checked + .bench-chip-label {
    background: color-mix(in srgb, var(--color-accent, #4ade80) 18%, transparent);
    border-color: var(--color-accent, #4ade80);
    color: var(--color-accent, #4ade80);
}
.bench-actions { margin-left: auto; display: flex; gap: 8px; align-items: center; }

.bench-phases {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--color-border, #1e293b);
}
.bench-phase {
    border: 1px solid var(--color-border, #1e293b);
    border-radius: 8px;
    padding: 10px 12px;
    transition: border-color 0.2s;
}
.bench-phase.is-active { border-color: var(--color-accent, #4ade80); }
.bench-phase.is-done   { border-color: #22c55e; }
.bench-phase-title { font-size: 0.7rem; font-weight: 700; color: var(--color-fg-muted, #94a3b8); text-transform: uppercase; letter-spacing: .06em; }
.bench-phase.is-active .bench-phase-title { color: var(--color-accent, #4ade80); }
.bench-phase.is-done   .bench-phase-title { color: #22c55e; }
.bench-phase-sub { font-size: 0.65rem; color: var(--color-fg-muted, #64748b); margin-top: 2px; }
.bench-phase-bar-track { height: 3px; background: var(--color-surface-3, #1e293b); border-radius: 2px; margin-top: 8px; overflow: hidden; }
.bench-phase-bar-fill  { height: 100%; background: var(--color-accent, #4ade80); border-radius: 2px; width: 0%; transition: width 0.3s; }

.bench-status {
    background: #0a0f1a;
    border: 1px solid var(--color-border, #1e293b);
    border-radius: 6px;
    padding: 8px 12px;
    margin: 0 16px 12px;
    font-family: monospace;
    font-size: 0.68rem;
}
.bench-status-header { display: flex; justify-content: space-between; color: var(--color-fg-muted, #64748b); margin-bottom: 4px; font-size: 0.62rem; text-transform: uppercase; letter-spacing: .06em; }
.bench-status-current { color: #60a5fa; margin-bottom: 2px; }
.bench-status-last    { color: var(--color-fg-muted, #94a3b8); margin-bottom: 2px; }
.bench-status-next    { color: var(--color-fg-muted, #475569); }
.bench-status-delta-good { color: #4ade80; }
.bench-status-delta-bad  { color: #f87171; }

.bench-graphs {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--color-border, #1e293b);
}
.bench-graph-card {
    border: 1px solid var(--color-border, #1e293b);
    border-radius: 8px;
    padding: 10px 12px;
}
.bench-graph-title { font-size: 0.65rem; color: var(--color-fg-muted, #64748b); text-transform: uppercase; letter-spacing: .06em; margin-bottom: 8px; }
.bench-graph-card canvas { display: block; width: 100%; height: 180px; }

.bench-table-shell {
    padding: 12px 16px;
    border-bottom: 1px solid var(--color-border, #1e293b);
    overflow-x: auto;
}
.bench-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.7rem;
}
.bench-table th {
    text-align: left;
    padding: 4px 8px;
    color: var(--color-fg-muted, #64748b);
    border-bottom: 1px solid var(--color-border, #1e293b);
    cursor: pointer;
    user-select: none;
    white-space: nowrap;
}
.bench-table th:hover { color: var(--color-fg, #e2e8f0); }
.bench-table th.sort-asc::after  { content: ' ↑'; }
.bench-table th.sort-desc::after { content: ' ↓'; }
.bench-table td { padding: 3px 8px; border-bottom: 1px solid color-mix(in srgb, var(--color-border,#1e293b) 50%, transparent); }
.bench-table tr.is-best { background: color-mix(in srgb, #4ade80 6%, transparent); }
.bench-table td.is-best-cell { color: #4ade80; font-weight: 700; }

.bench-presets {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px;
    padding: 14px 16px;
}
.bench-preset-card {
    border: 1px solid var(--preset-color, #475569);
    border-radius: 8px;
    padding: 12px;
}
.bench-preset-card--low      { --preset-color: #f87171; }
.bench-preset-card--medium   { --preset-color: #fbbf24; }
.bench-preset-card--high     { --preset-color: #4ade80; }
.bench-preset-card--lossless { --preset-color: #818cf8; }
.bench-preset-title { font-weight: 700; font-size: 0.85rem; color: var(--preset-color); margin-bottom: 6px; }
.bench-preset-params { font-size: 0.68rem; color: var(--color-fg-muted, #94a3b8); line-height: 1.8; font-family: monospace; }
.bench-preset-timing { font-size: 0.62rem; color: var(--color-fg-muted, #64748b); margin-top: 6px; line-height: 1.6; }
.bench-preset-copy {
    display: block;
    width: 100%;
    margin-top: 8px;
    padding: 4px 0;
    background: var(--preset-color);
    color: #000;
    border: none;
    border-radius: 4px;
    font-size: 0.68rem;
    font-weight: 700;
    cursor: pointer;
    text-align: center;
}
.bench-preset-copy.copied { opacity: 0.7; }
```

- [ ] **Step 4.2: Create `web/jxl-preset-benchmark.html`**

```html
<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <link rel="icon" href="data:," />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>JXL Preset Benchmark</title>
    <link rel="stylesheet" href="./test-nav.css" />
    <link rel="stylesheet" href="./jxl-wrapper-lab.css" />
    <link rel="stylesheet" href="./jxl-dashboard.css" />
    <link rel="stylesheet" href="./jxl-debug-console.css" />
    <link rel="stylesheet" href="./jxl-preset-benchmark.css" />
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
    <script type="importmap">
    {
      "imports": {
        "@casabio/jxl-core":           "../packages/jxl-core/dist/index.js",
        "@casabio/jxl-core/errors":    "../packages/jxl-core/dist/errors.js",
        "@casabio/jxl-core/protocol":  "../packages/jxl-core/dist/protocol.js",
        "@casabio/jxl-core/types":     "../packages/jxl-core/dist/types.js",
        "@casabio/jxl-wasm":           "../packages/jxl-wasm/dist/index.js",
        "@casabio/jxl-capabilities":   "../packages/jxl-capabilities/dist/index.js"
      }
    }
    </script>
</head>
<body class="has-home-bar">
    <nav class="home-bar" aria-label="Test pages">
        <div class="home-bar-label">Test pages</div>
        <div class="home-bar-links">
            <a class="home-bar-link" href="./index.html">Home</a>
            <a class="home-bar-link" href="./jxl-progressive.html">Progressive decode</a>
            <a class="home-bar-link" href="./jxl-wrapper-lab.html">Wrapper lab</a>
            <a class="home-bar-link" href="./jxl-compare.html">Compare</a>
            <a class="home-bar-link" href="./jxl-benchmark.html">Benchmark</a>
            <a class="home-bar-link is-active" href="./jxl-preset-benchmark.html" aria-current="page">Preset benchmark</a>
            <a class="home-bar-link" href="./jxl-progressive-paint.html">Progressive paint</a>
            <a class="home-bar-link" href="./jxl-progressive-gallery.html">Progressive gallery</a>
            <a class="home-bar-link" href="./jxl-crop-benchmark.html">Crop benchmark</a>
        </div>
    </nav>

    <main class="shell">
        <section class="hero compact">
            <div class="hero-copy">
                <p class="eyebrow">JXL Preset Benchmark</p>
                <h1>Derive optimal encode presets</h1>
                <p class="lede">Drop one representative file per type. The sweep measures encode + decode time across four quality tiers and four image sizes, then recommends the fastest parameter set for each tier.</p>
            </div>
        </section>

        <!-- ① File intake -->
        <section class="bench-intake" id="bench-intake" aria-label="File intake">
            <div class="bench-slot bench-slot--orf" id="slot-orf" tabindex="0" role="button" aria-label="Drop ORF file">
                <input type="file" accept=".orf,.ORF" hidden id="input-orf" />
                <div class="bench-slot-type">ORF</div>
                <div class="bench-slot-hint">Olympus RAW</div>
                <div class="bench-slot-filename" id="filename-orf" hidden></div>
            </div>
            <div class="bench-slot bench-slot--dng" id="slot-dng" tabindex="0" role="button" aria-label="Drop DNG file">
                <input type="file" accept=".dng,.DNG" hidden id="input-dng" />
                <div class="bench-slot-type">DNG</div>
                <div class="bench-slot-hint">Digital Negative</div>
                <div class="bench-slot-filename" id="filename-dng" hidden></div>
            </div>
            <div class="bench-slot bench-slot--cr2" id="slot-cr2" tabindex="0" role="button" aria-label="Drop CR2 file">
                <input type="file" accept=".cr2,.CR2" hidden id="input-cr2" />
                <div class="bench-slot-type">CR2</div>
                <div class="bench-slot-hint">Canon RAW</div>
                <div class="bench-slot-filename" id="filename-cr2" hidden></div>
            </div>
            <div class="bench-slot bench-slot--jpeg" id="slot-jpeg" tabindex="0" role="button" aria-label="Drop JPEG file">
                <input type="file" accept=".jpg,.jpeg,.JPG,.JPEG" hidden id="input-jpeg" />
                <div class="bench-slot-type">JPEG</div>
                <div class="bench-slot-hint">or PNG / WebP</div>
                <div class="bench-slot-filename" id="filename-jpeg" hidden></div>
            </div>
            <div class="bench-slot bench-slot--other" id="slot-other" tabindex="0" role="button" aria-label="Drop any image file">
                <input type="file" accept="image/*,.orf,.ORF,.cr2,.CR2,.dng,.DNG" hidden id="input-other" />
                <div class="bench-slot-type">OTHER</div>
                <div class="bench-slot-hint">any image</div>
                <div class="bench-slot-filename" id="filename-other" hidden></div>
            </div>
        </section>

        <!-- ② Sweep settings -->
        <section class="bench-settings" aria-label="Sweep settings">
            <div class="bench-settings-group">
                <div class="bench-settings-label">Image sizes</div>
                <div class="bench-settings-chips">
                    <input type="checkbox" class="bench-chip-check" id="size-128" value="128" checked />
                    <label class="bench-chip-label" for="size-128">128 px</label>
                    <input type="checkbox" class="bench-chip-check" id="size-512" value="512" checked />
                    <label class="bench-chip-label" for="size-512">512 px</label>
                    <input type="checkbox" class="bench-chip-check" id="size-1920" value="1920" checked />
                    <label class="bench-chip-label" for="size-1920">1920 px</label>
                    <input type="checkbox" class="bench-chip-check" id="size-full" value="full" checked />
                    <label class="bench-chip-label" for="size-full">Full</label>
                </div>
            </div>
            <div class="bench-settings-group">
                <div class="bench-settings-label">Quality tiers</div>
                <div class="bench-settings-chips">
                    <input type="checkbox" class="bench-chip-check" id="tier-low" value="low" checked />
                    <label class="bench-chip-label" for="tier-low">Low</label>
                    <input type="checkbox" class="bench-chip-check" id="tier-medium" value="medium" checked />
                    <label class="bench-chip-label" for="tier-medium">Medium</label>
                    <input type="checkbox" class="bench-chip-check" id="tier-high" value="high" checked />
                    <label class="bench-chip-label" for="tier-high">High</label>
                    <input type="checkbox" class="bench-chip-check" id="tier-lossless" value="lossless" checked />
                    <label class="bench-chip-label" for="tier-lossless">Lossless</label>
                </div>
            </div>
            <div class="bench-settings-group">
                <div class="bench-settings-label">Runs / config</div>
                <div class="spinpicker" style="margin-top:2px">
                    <button class="spin-btn spin-dec" type="button" data-target="runs-per-config">&#8722;</button>
                    <input id="runs-per-config" type="number" min="1" max="5" step="1" value="3" style="width:3rem" />
                    <button class="spin-btn spin-inc" type="button" data-target="runs-per-config">+</button>
                </div>
            </div>
            <div class="bench-actions">
                <button id="btn-run" class="primary-btn" type="button" disabled>&#9654; Run sweep</button>
                <button id="btn-stop" class="secondary-btn" type="button" disabled>&#9632; Stop</button>
                <button id="btn-load-saved" class="secondary-btn" type="button">Load saved</button>
                <button id="btn-export-csv" class="secondary-btn" type="button" disabled>Export CSV</button>
                <button id="btn-console" class="secondary-btn console-btn" type="button">Console</button>
            </div>
        </section>

        <!-- ③ Phase progress + live status -->
        <section aria-label="Sweep progress" style="padding: 12px 16px; border-bottom: 1px solid var(--color-border,#1e293b)">
            <div class="bench-phases">
                <div class="bench-phase" id="phase-card-1">
                    <div class="bench-phase-title">Phase 1 — Effort</div>
                    <div class="bench-phase-sub">effort 1–6 × image sizes</div>
                    <div class="bench-phase-bar-track"><div class="bench-phase-bar-fill" id="phase-bar-1"></div></div>
                </div>
                <div class="bench-phase" id="phase-card-2">
                    <div class="bench-phase-title">Phase 2 — Decode speed</div>
                    <div class="bench-phase-sub">tier 0–4 × image sizes</div>
                    <div class="bench-phase-bar-track"><div class="bench-phase-bar-fill" id="phase-bar-2"></div></div>
                </div>
                <div class="bench-phase" id="phase-card-3">
                    <div class="bench-phase-title">Phase 3 — Modular + Brotli</div>
                    <div class="bench-phase-sub">3 modes × 4 brotli values</div>
                    <div class="bench-phase-bar-track"><div class="bench-phase-bar-fill" id="phase-bar-3"></div></div>
                </div>
                <div class="bench-phase" id="phase-card-4">
                    <div class="bench-phase-title">Phase 4 — Resampling</div>
                    <div class="bench-phase-sub">1× / 2× / 4× × image sizes</div>
                    <div class="bench-phase-bar-track"><div class="bench-phase-bar-fill" id="phase-bar-4"></div></div>
                </div>
            </div>
            <div class="bench-status" id="bench-status">
                <div class="bench-status-header">
                    <span>Live status</span>
                    <span id="status-elapsed">—</span>
                </div>
                <div class="bench-status-current" id="status-current">Idle — load files and press Run sweep.</div>
                <div class="bench-status-last"    id="status-last"></div>
                <div class="bench-status-next"    id="status-next"></div>
            </div>
        </section>

        <!-- ④ Phase graphs -->
        <section class="bench-graphs" id="bench-graphs" aria-label="Phase graphs">
            <div class="bench-graph-card">
                <div class="bench-graph-title">Phase 1 — Encode time vs Effort (by image size)</div>
                <canvas id="graph-p1-enc"></canvas>
            </div>
            <div class="bench-graph-card">
                <div class="bench-graph-title">Phase 1 — File size vs Effort (by image size)</div>
                <canvas id="graph-p1-size"></canvas>
            </div>
            <div class="bench-graph-card">
                <div class="bench-graph-title">Phase 2 — Decode time vs Speed tier (by image size)</div>
                <canvas id="graph-p2-dec"></canvas>
            </div>
            <div class="bench-graph-card">
                <div class="bench-graph-title">Phase 3 — Encode time by Modular × Brotli</div>
                <canvas id="graph-p3-mod"></canvas>
            </div>
        </section>

        <!-- ⑤ Results table -->
        <section class="bench-table-shell" id="bench-table-shell" hidden>
            <p class="eyebrow" style="margin-bottom:6px">Raw results — click column header to sort</p>
            <table class="bench-table" id="bench-table">
                <thead>
                    <tr>
                        <th data-col="file">File</th>
                        <th data-col="size">Size</th>
                        <th data-col="tier">Tier</th>
                        <th data-col="phase">Ph</th>
                        <th data-col="effort">Effort</th>
                        <th data-col="decSpeed">DecSpd</th>
                        <th data-col="modular">Mod</th>
                        <th data-col="brotli">Brotli</th>
                        <th data-col="resamp">Resamp</th>
                        <th data-col="encMs">Enc ms</th>
                        <th data-col="decMs">Dec ms</th>
                        <th data-col="sizeKb">KB</th>
                        <th data-col="score">Score↑</th>
                    </tr>
                </thead>
                <tbody id="bench-table-body"></tbody>
            </table>
        </section>

        <!-- ⑥ Preset cards -->
        <section class="bench-presets" id="bench-presets" aria-label="Recommended presets">
            <div class="bench-preset-card bench-preset-card--low" id="preset-low">
                <div class="bench-preset-title">LOW</div>
                <div class="bench-preset-params" id="preset-params-low">—</div>
                <div class="bench-preset-timing" id="preset-timing-low"></div>
                <button class="bench-preset-copy" id="preset-copy-low" type="button" disabled>Copy JSON</button>
            </div>
            <div class="bench-preset-card bench-preset-card--medium" id="preset-medium">
                <div class="bench-preset-title">MEDIUM</div>
                <div class="bench-preset-params" id="preset-params-medium">—</div>
                <div class="bench-preset-timing" id="preset-timing-medium"></div>
                <button class="bench-preset-copy" id="preset-copy-medium" type="button" disabled>Copy JSON</button>
            </div>
            <div class="bench-preset-card bench-preset-card--high" id="preset-high">
                <div class="bench-preset-title">HIGH</div>
                <div class="bench-preset-params" id="preset-params-high">—</div>
                <div class="bench-preset-timing" id="preset-timing-high"></div>
                <button class="bench-preset-copy" id="preset-copy-high" type="button" disabled>Copy JSON</button>
            </div>
            <div class="bench-preset-card bench-preset-card--lossless" id="preset-lossless">
                <div class="bench-preset-title">LOSSLESS</div>
                <div class="bench-preset-params" id="preset-params-lossless">—</div>
                <div class="bench-preset-timing" id="preset-timing-lossless"></div>
                <button class="bench-preset-copy" id="preset-copy-lossless" type="button" disabled>Copy JSON</button>
            </div>
        </section>
    </main>

    <script>
    document.querySelectorAll('.spin-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const input = document.getElementById(btn.dataset.target);
            if (!input) return;
            if (btn.classList.contains('spin-inc')) input.stepUp();
            else input.stepDown();
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
    });
    </script>
    <script type="module" src="./jxl-preset-benchmark.js"></script>
    <script src="./info-popover-init.js"></script>
</body>
</html>
```

- [ ] **Step 4.3: Verify page loads**

Open `http://localhost:PORT/jxl-preset-benchmark.html` in browser. Confirm: five file slots visible, sweep settings row, four phase cards, no console errors.

- [ ] **Step 4.4: Add nav link to all other pages**

In each of `jxl-wrapper-lab.html`, `jxl-benchmark.html`, `jxl-progressive-paint.html`, `jxl-progressive-gallery.html`, `jxl-crop-benchmark.html`, `animation-lab.html`, add inside `.home-bar-links`:

```html
            <a class="home-bar-link" href="./jxl-preset-benchmark.html">Preset benchmark</a>
```

- [ ] **Step 4.5: Commit**

```bash
git add web/jxl-preset-benchmark.html web/jxl-preset-benchmark.css web/jxl-wrapper-lab.html web/jxl-benchmark.html web/jxl-progressive-paint.html web/jxl-progressive-gallery.html web/jxl-crop-benchmark.html web/animation-lab.html
git commit -m "feat(preset-bench): HTML shell, CSS, nav links"
```

---

## Task 5: Preset benchmark — IDB + file intake JS

**Files:**
- Create: `web/jxl-preset-benchmark.js` (initial, grows through Tasks 5–10)

- [ ] **Step 5.1: Create `jxl-preset-benchmark.js` with imports, IDB helpers, and constants**

```js
import initRaw, * as rawWasm from '../pkg/raw_converter_wasm.js';
import { createEncoder, createDecoder } from '@casabio/jxl-wasm';
import { initDebugConsole, dbgLog } from './jxl-debug-console.js';

const { process_orf, process_cr2, process_dng, rgb_to_rgba, downscale_rgba } = rawWasm;

// ─── Constants ────────────────────────────────────────────────────────────────

const TIERS = [
    { id: 'low',      label: 'Low',      quality: 72,  lossless: false },
    { id: 'medium',   label: 'Medium',   quality: 85,  lossless: false },
    { id: 'high',     label: 'High',     quality: 92,  lossless: false },
    { id: 'lossless', label: 'Lossless', quality: 100, lossless: true  },
];

const EFFORT_STEPS   = [1, 2, 3, 4, 5, 6];
const DEC_SPEED_STEPS = [0, 1, 2, 3, 4];
const MODULAR_STEPS  = [-1, 0, 1];
const BROTLI_STEPS   = [-1, 0, 4, 9];
const RESAMP_STEPS   = [1, 2, 4];

const SLOT_IDS = ['orf', 'dng', 'cr2', 'jpeg', 'other'];
const IDB_DB   = 'jxl-preset-bench';
const IDB_STORE = 'sources';
const LS_RESULTS_KEY = 'jxl-preset-bench-results';

// ─── IDB helpers ──────────────────────────────────────────────────────────────

function openIdb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_DB, 1);
        req.onupgradeneeded = e => e.target.result.createObjectStore(IDB_STORE);
        req.onsuccess = e => resolve(e.target.result);
        req.onerror   = e => reject(e.target.error);
    });
}

async function idbGet(db, key) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).get(key);
        req.onsuccess = e => resolve(e.target.result ?? null);
        req.onerror   = e => reject(e.target.error);
    });
}

async function idbPut(db, key, value) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        const req = tx.objectStore(IDB_STORE).put(value, key);
        req.onsuccess = () => resolve();
        req.onerror   = e => reject(e.target.error);
    });
}

// ─── State ────────────────────────────────────────────────────────────────────

let db = null;
let sweepAborted = false;
let sweepRunning = false;
const sources = {};        // slotId → { name, width, height, rgba: Uint8Array (full-res) }
const allResults = [];     // all SweepRow objects accumulated across phases
const chartInstances = {}; // canvas id → Chart instance
let sortCol = 'score';
let sortDir = 'desc';
let sweepStartMs = 0;
```

- [ ] **Step 5.2: Add file decode helpers**

Append to `jxl-preset-benchmark.js`:

```js
// ─── File decode helpers ───────────────────────────────────────────────────────

function decodeRawFile(bytes, ext) {
    const processFn = ext === 'cr2' ? process_cr2
                    : ext === 'dng' ? process_dng
                    : process_orf;
    const result = processFn(bytes, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NaN, NaN, 0, 0);
    try {
        const rgb = result.take_rgb();
        return { rgba: rgb_to_rgba(rgb), width: result.width, height: result.height };
    } finally {
        result.free();
    }
}

async function decodeWebImage(bytes, mimeType) {
    const blob = new Blob([bytes], { type: mimeType });
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    bitmap.close?.();
    return { rgba: new Uint8Array(pixels.buffer.slice(0)), width: canvas.width, height: canvas.height };
}

async function decodeBytesForSlot(bytes, ext) {
    if (['orf', 'cr2', 'dng'].includes(ext)) {
        return decodeRawFile(bytes, ext);
    }
    const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
                      webp: 'image/webp', tif: 'image/tiff', tiff: 'image/tiff' };
    return decodeWebImage(bytes, mimeMap[ext] ?? 'image/jpeg');
}

function resizeSource(source, targetLongEdge) {
    if (targetLongEdge === 'full') return source;
    const { rgba, width, height } = source;
    const maxEdge = Math.max(width, height);
    if (maxEdge <= targetLongEdge) return source;
    const scale = targetLongEdge / maxEdge;
    const tw = Math.max(1, Math.round(width * scale));
    const th = Math.max(1, Math.round(height * scale));
    const resized = (rawWasm.downscale_rgba ?? downscaleRgbaCanvas)(rgba, width, height, tw, th);
    return { rgba: resized, width: tw, height: th };
}

function downscaleRgbaCanvas(rgba, width, height, tw, th) {
    const src = document.createElement('canvas');
    src.width = width; src.height = height;
    const sctx = src.getContext('2d', { willReadFrequently: true });
    sctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
    const dst = document.createElement('canvas');
    dst.width = tw; dst.height = th;
    const dctx = dst.getContext('2d', { willReadFrequently: true });
    dctx.drawImage(src, 0, 0, tw, th);
    return new Uint8Array(dctx.getImageData(0, 0, tw, th).data.buffer);
}
```

- [ ] **Step 5.3: Add file intake UI wiring**

Append to `jxl-preset-benchmark.js`:

```js
// ─── File intake UI ───────────────────────────────────────────────────────────

function showFilename(slotId, name) {
    const el = document.getElementById(`filename-${slotId}`);
    const slot = document.getElementById(`slot-${slotId}`);
    if (!el || !slot) return;
    el.textContent = name;
    el.hidden = false;
    slot.classList.add('has-file');
}

async function handleFileForSlot(slotId, file) {
    if (!file) return;
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    try {
        updateStatusCurrent(`Loading ${file.name}…`);
        const bytes = new Uint8Array(await file.arrayBuffer());
        const decoded = await decodeBytesForSlot(bytes, ext);
        sources[slotId] = { name: file.name, ...decoded };
        if (db) await idbPut(db, slotId, { name: file.name, bytes, ext });
        showFilename(slotId, file.name);
        dbgLog(`[intake] ${slotId} → ${file.name} ${decoded.width}×${decoded.height}`);
        updateRunButton();
        updateStatusCurrent(`Loaded ${file.name} (${decoded.width}×${decoded.height})`);
    } catch (err) {
        dbgLog(`[intake] ${slotId} error: ${err?.message}`, '', 'error');
        updateStatusCurrent(`Error loading ${file.name}: ${err?.message}`);
    }
}

function wireFileSlot(slotId) {
    const slot  = document.getElementById(`slot-${slotId}`);
    const input = document.getElementById(`input-${slotId}`);
    if (!slot || !input) return;

    slot.addEventListener('click', () => input.click());
    slot.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') input.click(); });
    input.addEventListener('change', () => {
        if (input.files?.[0]) handleFileForSlot(slotId, input.files[0]);
    });
    slot.addEventListener('dragover', e => { e.preventDefault(); slot.classList.add('is-drag-over'); });
    slot.addEventListener('dragleave', () => slot.classList.remove('is-drag-over'));
    slot.addEventListener('drop', e => {
        e.preventDefault();
        slot.classList.remove('is-drag-over');
        const file = e.dataTransfer?.files?.[0];
        if (file) handleFileForSlot(slotId, file);
    });
}

async function restoreFromIdb() {
    if (!db) return;
    for (const slotId of SLOT_IDS) {
        const record = await idbGet(db, slotId).catch(() => null);
        if (!record) continue;
        try {
            const decoded = await decodeBytesForSlot(record.bytes, record.ext);
            sources[slotId] = { name: record.name, ...decoded };
            showFilename(slotId, record.name);
            dbgLog(`[intake] restored ${slotId} → ${record.name}`);
        } catch (err) {
            dbgLog(`[intake] restore ${slotId} failed: ${err?.message}`, '', 'error');
        }
    }
    updateRunButton();
}
```

- [ ] **Step 5.4: Commit**

```bash
git add web/jxl-preset-benchmark.js
git commit -m "feat(preset-bench): IDB helpers + file intake + decode"
```

---

## Task 6: Preset benchmark — sweep engine

**Files:**
- Modify: `web/jxl-preset-benchmark.js` (append)

- [ ] **Step 6.1: Add encode/decode primitives and status helpers**

Append to `jxl-preset-benchmark.js`:

```js
// ─── Status UI helpers ────────────────────────────────────────────────────────

function updateStatusCurrent(msg) {
    const el = document.getElementById('status-current');
    if (el) el.textContent = msg;
}
function updateStatusLast(msg) {
    const el = document.getElementById('status-last');
    if (el) el.textContent = msg;
}
function updateStatusNext(msg) {
    const el = document.getElementById('status-next');
    if (el) el.textContent = msg;
}
function updateStatusElapsed() {
    const el = document.getElementById('status-elapsed');
    if (el && sweepStartMs) el.textContent = `${((performance.now() - sweepStartMs) / 1000).toFixed(0)} s elapsed`;
}
function setPhaseActive(n)  { setPhaseState(n, 'is-active'); }
function setPhasesDone(n)   { setPhaseState(n, 'is-done');   }
function setPhaseState(n, cls) {
    const card = document.getElementById(`phase-card-${n}`);
    if (!card) return;
    card.classList.remove('is-active', 'is-done');
    card.classList.add(cls);
}
function setPhaseProgress(n, pct) {
    const bar = document.getElementById(`phase-bar-${n}`);
    if (bar) bar.style.width = `${Math.round(pct)}%`;
}

function fmtMs(ms) { return Number.isFinite(ms) ? `${ms.toFixed(0)} ms` : '--'; }
function fmtKb(b)  { return Number.isFinite(b)  ? `${(b / 1024).toFixed(0)} KB` : '--'; }
function nextFrame() { return new Promise(r => requestAnimationFrame(r)); }

// ─── Encode / decode primitives ───────────────────────────────────────────────

function exactBuffer(view) {
    if (view instanceof ArrayBuffer) return view;
    if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view.buffer;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

function concatChunks(chunks) {
    const views = chunks.map(c => c instanceof Uint8Array ? c : new Uint8Array(c));
    if (views.length === 1) return views[0];
    const total = views.reduce((s, v) => s + v.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const v of views) { out.set(v, off); off += v.byteLength; }
    return out;
}

async function encodeOnce(source, opts) {
    const t0 = performance.now();
    const encoder = createEncoder({ format: 'rgba8', width: source.width, height: source.height,
                                    hasAlpha: true, progressive: false, previewFirst: false,
                                    chunked: false, ...opts });
    const chunks = [];
    const chunkTask = (async () => {
        for await (const chunk of encoder.chunks()) chunks.push(chunk);
    })();
    await encoder.pushPixels(exactBuffer(source.rgba));
    await encoder.finish();
    await chunkTask;
    await encoder.dispose();
    return { bytes: concatChunks(chunks), encMs: performance.now() - t0 };
}

async function decodeOnce(bytes) {
    const t0 = performance.now();
    const decoder = createDecoder({ format: 'rgba8', region: null, downsample: 1,
                                    progressionTarget: 'final', emitEveryPass: false,
                                    preserveIcc: false, preserveMetadata: false });
    await decoder.push(exactBuffer(bytes));
    await decoder.close();
    let final = null;
    for await (const ev of decoder.events()) { if (ev.type === 'final') final = ev; }
    await decoder.dispose();
    return { decMs: performance.now() - t0, width: final?.info?.width ?? 0 };
}

async function runConfig(source, encOpts, runsPerConfig) {
    const encMsArr = [], decMsArr = [], sizes = [];
    let bytes = null;
    for (let i = 0; i < runsPerConfig; i++) {
        if (sweepAborted) throw new Error('aborted');
        const enc = await encodeOnce(source, encOpts);
        bytes = enc.bytes;
        const dec = await decodeOnce(bytes);
        encMsArr.push(enc.encMs);
        decMsArr.push(dec.decMs);
        sizes.push(bytes.byteLength);
        await nextFrame();
    }
    const med = arr => [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)];
    return { encMs: med(encMsArr), decMs: med(decMsArr), sizeBytes: med(sizes) };
}
```

- [ ] **Step 6.2: Add knee-point algorithm and base encode options builder**

Append to `jxl-preset-benchmark.js`:

```js
// ─── Knee-point and scoring ───────────────────────────────────────────────────

function findKnee(effortSteps, results) {
    // results: array of { effort, encMs, sizeBytes } sorted by effort ascending
    if (results.length < 2) return effortSteps[0];
    for (let i = 1; i < results.length; i++) {
        const prev = results[i - 1];
        const curr = results[i];
        const sizeRed  = (prev.sizeBytes - curr.sizeBytes) / prev.sizeBytes;
        const timeCost = (curr.encMs    - prev.encMs)      / prev.encMs;
        if (timeCost > 3 * sizeRed) return prev.effort;
    }
    return results[results.length - 1].effort;
}

function computeScore(row, peerRows) {
    // score 0–100, higher = better; normalised within peerRows
    const minSize = Math.min(...peerRows.map(r => r.sizeBytes));
    const minEnc  = Math.min(...peerRows.map(r => r.encMs));
    const minDec  = Math.min(...peerRows.map(r => r.decMs));
    const sizeEff  = row.sizeBytes > 0 ? minSize / row.sizeBytes : 0;
    const encSpeed = row.encMs    > 0 ? minEnc  / row.encMs    : 0;
    const decSpeed = row.decMs    > 0 ? minDec  / row.decMs    : 0;
    return Math.round((sizeEff * 0.4 + encSpeed * 0.4 + decSpeed * 0.2) * 100);
}

function baseEncOpts(tier, extraOpts = {}) {
    return {
        distance: tier.lossless ? 0 : null,
        quality:  tier.lossless ? null : tier.quality,
        lossless: tier.lossless,
        ...extraOpts,
    };
}
```

- [ ] **Step 6.3: Add the four sweep phases**

Append to `jxl-preset-benchmark.js`:

```js
// ─── Sweep phases ────────────────────────────────────────────────────────────

async function runPhase1(tier, enabledSizes, runsPerConfig, bestParams) {
    // Returns { bestEffort: { [sizeLabel]: number } }
    setPhaseActive(1);
    const activeSources = SLOT_IDS.filter(id => sources[id]);
    const total = activeSources.length * enabledSizes.length * EFFORT_STEPS.length;
    let done = 0;
    const resultsBySize = {};

    for (const sizeVal of enabledSizes) {
        const sizeLabel = sizeVal === 'full' ? 'full' : `${sizeVal}px`;
        resultsBySize[sizeLabel] = [];

        for (const effort of EFFORT_STEPS) {
            for (const slotId of activeSources) {
                if (sweepAborted) return null;
                const src = resizeSource(sources[slotId], sizeVal);
                updateStatusCurrent(`P1 · ${tier.label} · ${slotId.toUpperCase()} · ${sizeLabel} · effort=${effort}`);
                updateStatusNext(`next → effort=${effort + 1 <= 6 ? effort + 1 : '—'}`);
                const encOpts = baseEncOpts(tier, { effort, decodingSpeed: 0 });
                const r = await runConfig(src, encOpts, runsPerConfig);
                const row = { file: slotId, size: sizeLabel, tier: tier.id, phase: 1,
                               effort, decSpeed: 0, modular: -1, brotli: -1, resamp: 1,
                               encMs: r.encMs, decMs: r.decMs, sizeBytes: r.sizeBytes, score: 0 };
                allResults.push(row);
                resultsBySize[sizeLabel].push({ effort, ...r });
                updateStatusLast(`enc ${fmtMs(r.encMs)} · dec ${fmtMs(r.decMs)} · ${fmtKb(r.sizeBytes)}`);
                done++;
                setPhaseProgress(1, (done / total) * 100);
                updateStatusElapsed();
                await nextFrame();
                renderTableIncremental();
                renderP1Charts();
            }
        }
    }

    // Derive best effort per size
    const bestEffort = {};
    for (const [sizeLabel, rows] of Object.entries(resultsBySize)) {
        const sorted = [...rows].sort((a, b) => a.effort - b.effort);
        bestEffort[sizeLabel] = findKnee(EFFORT_STEPS, sorted);
    }
    setPhasesDone(1);
    setPhaseProgress(1, 100);
    bestParams.effort = bestEffort;
    dbgLog(`[P1] best effort by size: ${JSON.stringify(bestEffort)}`);
    return bestEffort;
}

async function runPhase2(tier, enabledSizes, runsPerConfig, bestParams) {
    setPhaseActive(2);
    const activeSources = SLOT_IDS.filter(id => sources[id]);
    const total = activeSources.length * enabledSizes.length * DEC_SPEED_STEPS.length;
    let done = 0;
    const resultsBySize = {};

    for (const sizeVal of enabledSizes) {
        const sizeLabel = sizeVal === 'full' ? 'full' : `${sizeVal}px`;
        const effort = bestParams.effort?.[sizeLabel] ?? 3;
        resultsBySize[sizeLabel] = [];

        for (const decSpeed of DEC_SPEED_STEPS) {
            for (const slotId of activeSources) {
                if (sweepAborted) return null;
                const src = resizeSource(sources[slotId], sizeVal);
                updateStatusCurrent(`P2 · ${tier.label} · ${slotId.toUpperCase()} · ${sizeLabel} · decSpeed=${decSpeed}`);
                const encOpts = baseEncOpts(tier, { effort, decodingSpeed: decSpeed });
                const r = await runConfig(src, encOpts, runsPerConfig);
                const row = { file: slotId, size: sizeLabel, tier: tier.id, phase: 2,
                               effort, decSpeed, modular: -1, brotli: -1, resamp: 1,
                               encMs: r.encMs, decMs: r.decMs, sizeBytes: r.sizeBytes, score: 0 };
                allResults.push(row);
                resultsBySize[sizeLabel].push({ decSpeed, ...r });
                updateStatusLast(`enc ${fmtMs(r.encMs)} · dec ${fmtMs(r.decMs)}`);
                done++;
                setPhaseProgress(2, (done / total) * 100);
                updateStatusElapsed();
                await nextFrame();
                renderTableIncremental();
                renderP2Charts();
            }
        }
    }

    // Best decSpeed: minimises decMs, not penalising encMs > 2× tier-0 baseline
    const bestDecSpeed = {};
    for (const [sizeLabel, rows] of Object.entries(resultsBySize)) {
        const baselineEnc = rows.find(r => r.decSpeed === 0)?.encMs ?? Infinity;
        const candidates = rows.filter(r => r.encMs <= baselineEnc * 2);
        const best = candidates.reduce((a, b) => a.decMs <= b.decMs ? a : b, candidates[0]);
        bestDecSpeed[sizeLabel] = best?.decSpeed ?? 0;
    }
    setPhasesDone(2);
    setPhaseProgress(2, 100);
    bestParams.decSpeed = bestDecSpeed;
    dbgLog(`[P2] best decSpeed: ${JSON.stringify(bestDecSpeed)}`);
    return bestDecSpeed;
}

async function runPhase3(tier, runsPerConfig, bestParams) {
    // Phase 3 runs at 512px only (representative)
    setPhaseActive(3);
    const activeSources = SLOT_IDS.filter(id => sources[id]);
    const total = activeSources.length * MODULAR_STEPS.length * BROTLI_STEPS.length;
    let done = 0;
    const allP3 = [];
    const sizeLabel = '512px';
    const effort   = bestParams.effort?.[sizeLabel] ?? 3;
    const decSpeed = bestParams.decSpeed?.[sizeLabel] ?? 0;

    for (const modular of MODULAR_STEPS) {
        for (const brotli of BROTLI_STEPS) {
            for (const slotId of activeSources) {
                if (sweepAborted) return null;
                const src = resizeSource(sources[slotId], 512);
                updateStatusCurrent(`P3 · ${tier.label} · ${slotId.toUpperCase()} · 512px · mod=${modular} brotli=${brotli}`);
                const encOpts = baseEncOpts(tier, {
                    effort, decodingSpeed: decSpeed,
                    modular: modular !== -1 ? modular : undefined,
                    brotliEffort: brotli >= 0 ? brotli : undefined,
                });
                const r = await runConfig(src, encOpts, runsPerConfig);
                const row = { file: slotId, size: sizeLabel, tier: tier.id, phase: 3,
                               effort, decSpeed, modular, brotli, resamp: 1,
                               encMs: r.encMs, decMs: r.decMs, sizeBytes: r.sizeBytes, score: 0 };
                allResults.push(row);
                allP3.push({ modular, brotli, ...r });
                done++;
                setPhaseProgress(3, (done / total) * 100);
                updateStatusElapsed();
                await nextFrame();
                renderTableIncremental();
                renderP3Charts();
            }
        }
    }

    // Best = minimises encMs + sizeBytes combined (equal weight)
    const medByCombo = {};
    for (const r of allP3) {
        const k = `${r.modular}_${r.brotli}`;
        if (!medByCombo[k]) medByCombo[k] = { modular: r.modular, brotli: r.brotli, encMsArr: [], sizeArr: [] };
        medByCombo[k].encMsArr.push(r.encMs);
        medByCombo[k].sizeArr.push(r.sizeBytes);
    }
    const med = arr => [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)];
    const combos = Object.values(medByCombo).map(c => ({
        ...c, encMs: med(c.encMsArr), sizeBytes: med(c.sizeArr)
    }));
    const minEnc  = Math.min(...combos.map(c => c.encMs));
    const minSize = Math.min(...combos.map(c => c.sizeBytes));
    const best = combos.reduce((a, b) => {
        const scoreA = (minEnc / a.encMs) * 0.5 + (minSize / a.sizeBytes) * 0.5;
        const scoreB = (minEnc / b.encMs) * 0.5 + (minSize / b.sizeBytes) * 0.5;
        return scoreA >= scoreB ? a : b;
    });
    setPhasesDone(3);
    setPhaseProgress(3, 100);
    bestParams.modular = best.modular;
    bestParams.brotli  = best.brotli;
    dbgLog(`[P3] best modular=${best.modular} brotli=${best.brotli}`);
    return best;
}

async function runPhase4(tier, enabledSizes, runsPerConfig, bestParams) {
    setPhaseActive(4);
    const activeSources = SLOT_IDS.filter(id => sources[id]);
    const total = activeSources.length * enabledSizes.length * RESAMP_STEPS.length;
    let done = 0;

    for (const sizeVal of enabledSizes) {
        const sizeLabel = sizeVal === 'full' ? 'full' : `${sizeVal}px`;
        const effort   = bestParams.effort?.[sizeLabel]   ?? 3;
        const decSpeed = bestParams.decSpeed?.[sizeLabel] ?? 0;
        const modular  = bestParams.modular ?? -1;
        const brotli   = bestParams.brotli  ?? -1;

        for (const resamp of RESAMP_STEPS) {
            for (const slotId of activeSources) {
                if (sweepAborted) return null;
                const src = resizeSource(sources[slotId], sizeVal);
                updateStatusCurrent(`P4 · ${tier.label} · ${slotId.toUpperCase()} · ${sizeLabel} · resamp=${resamp}×`);
                const encOpts = baseEncOpts(tier, {
                    effort, decodingSpeed: decSpeed,
                    modular: modular !== -1 ? modular : undefined,
                    brotliEffort: brotli >= 0 ? brotli : undefined,
                    resampling: resamp,
                });
                const r = await runConfig(src, encOpts, runsPerConfig);
                const row = { file: slotId, size: sizeLabel, tier: tier.id, phase: 4,
                               effort, decSpeed, modular, brotli, resamp,
                               encMs: r.encMs, decMs: r.decMs, sizeBytes: r.sizeBytes, score: 0 };
                allResults.push(row);
                done++;
                setPhaseProgress(4, (done / total) * 100);
                updateStatusElapsed();
                await nextFrame();
                renderTableIncremental();
            }
        }
    }
    setPhasesDone(4);
    setPhaseProgress(4, 100);
}

// ─── Main sweep orchestrator ───────────────────────────────────────────────────

async function runSweep() {
    const enabledTiers = TIERS.filter(t => document.getElementById(`tier-${t.id}`)?.checked);
    const enabledSizes = ['128', '512', '1920', 'full']
        .filter(s => document.getElementById(`size-${s}`)?.checked)
        .map(s => s === 'full' ? 'full' : Number(s));
    const runsPerConfig = Math.max(1, Math.min(5, Number(document.getElementById('runs-per-config')?.value) || 3));

    if (!enabledTiers.length || !enabledSizes.length) {
        updateStatusCurrent('Select at least one tier and one image size.');
        return;
    }
    if (!SLOT_IDS.some(id => sources[id])) {
        updateStatusCurrent('Load at least one source file first.');
        return;
    }

    sweepAborted = false;
    sweepRunning = true;
    sweepStartMs = performance.now();
    allResults.length = 0;
    document.getElementById('btn-run').disabled = true;
    document.getElementById('btn-stop').disabled = false;
    document.getElementById('bench-table-shell').hidden = false;

    try {
        for (const tier of enabledTiers) {
            if (sweepAborted) break;
            dbgLog(`[sweep] starting tier: ${tier.label}`);
            const bestParams = {};
            await runPhase1(tier, enabledSizes, runsPerConfig, bestParams);
            if (sweepAborted) break;
            await runPhase2(tier, enabledSizes, runsPerConfig, bestParams);
            if (sweepAborted) break;
            await runPhase3(tier, runsPerConfig, bestParams);
            if (sweepAborted) break;
            await runPhase4(tier, enabledSizes, runsPerConfig, bestParams);
        }
        rescoreAllResults();
        renderTable();
        deriveAndShowPresets();
        persistResults();
        updateStatusCurrent(sweepAborted ? 'Sweep stopped.' : 'Sweep complete — see presets below.');
    } catch (err) {
        if (err?.message !== 'aborted') {
            dbgLog(`[sweep] error: ${err?.message}`, err?.stack || '', 'error');
            updateStatusCurrent(`Sweep error: ${err?.message}`);
        }
    } finally {
        sweepRunning = false;
        document.getElementById('btn-run').disabled = false;
        document.getElementById('btn-stop').disabled = true;
        document.getElementById('btn-export-csv').disabled = allResults.length === 0;
    }
}

function rescoreAllResults() {
    // Compute scores relative to peers in the same (tier, size, phase) group
    const groups = {};
    for (const row of allResults) {
        const k = `${row.tier}_${row.size}_${row.phase}`;
        (groups[k] = groups[k] || []).push(row);
    }
    for (const peers of Object.values(groups)) {
        for (const row of peers) row.score = computeScore(row, peers);
    }
}
```

- [ ] **Step 6.4: Commit**

```bash
git add web/jxl-preset-benchmark.js
git commit -m "feat(preset-bench): sweep engine phases 1-4 + knee-point + scoring"
```

---

## Task 7: Preset benchmark — Chart.js graphs

**Files:**
- Modify: `web/jxl-preset-benchmark.js` (append)

- [ ] **Step 7.1: Add chart render functions**

Append to `jxl-preset-benchmark.js`:

```js
// ─── Chart.js graphs ─────────────────────────────────────────────────────────

const SIZE_COLORS = { '128px': '#4ade80', '512px': '#60a5fa', '1920px': '#f97316', 'full': '#a78bfa' };
const CHART_OPTS_BASE = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } } },
};

function upsertChart(canvasId, config) {
    if (chartInstances[canvasId]) chartInstances[canvasId].destroy();
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    chartInstances[canvasId] = new Chart(canvas, config);
}

function renderP1Charts() {
    const p1 = allResults.filter(r => r.phase === 1);
    if (!p1.length) return;
    const sizes = [...new Set(p1.map(r => r.size))];
    const tiers = [...new Set(p1.map(r => r.tier))];

    // Average across files and tiers for each (size, effort) pair
    function avgBy(sizeLabel, field) {
        return EFFORT_STEPS.map(effort => {
            const rows = p1.filter(r => r.size === sizeLabel && r.effort === effort);
            if (!rows.length) return null;
            return rows.reduce((s, r) => s + r[field], 0) / rows.length;
        });
    }

    // Phase 1a: encode time vs effort
    upsertChart('graph-p1-enc', {
        type: 'line',
        data: {
            labels: EFFORT_STEPS,
            datasets: sizes.map(s => ({
                label: s, borderColor: SIZE_COLORS[s] || '#94a3b8',
                backgroundColor: 'transparent', data: avgBy(s, 'encMs'),
                tension: 0.2, pointRadius: 3,
            })),
        },
        options: { ...CHART_OPTS_BASE,
            scales: {
                x: { title: { display: true, text: 'Effort' } },
                y: { title: { display: true, text: 'Encode ms' }, beginAtZero: true },
            },
        },
    });

    // Phase 1b: file size vs effort
    upsertChart('graph-p1-size', {
        type: 'line',
        data: {
            labels: EFFORT_STEPS,
            datasets: sizes.map(s => ({
                label: s, borderColor: SIZE_COLORS[s] || '#94a3b8',
                backgroundColor: 'transparent',
                data: avgBy(s, 'sizeBytes').map(v => v != null ? v / 1024 : null),
                tension: 0.2, pointRadius: 3,
            })),
        },
        options: { ...CHART_OPTS_BASE,
            scales: {
                x: { title: { display: true, text: 'Effort' } },
                y: { title: { display: true, text: 'File size KB' }, beginAtZero: true },
            },
        },
    });
}

function renderP2Charts() {
    const p2 = allResults.filter(r => r.phase === 2);
    if (!p2.length) return;
    const sizes = [...new Set(p2.map(r => r.size))];

    function avgDecBy(sizeLabel) {
        return DEC_SPEED_STEPS.map(ds => {
            const rows = p2.filter(r => r.size === sizeLabel && r.decSpeed === ds);
            if (!rows.length) return null;
            return rows.reduce((s, r) => s + r.decMs, 0) / rows.length;
        });
    }

    upsertChart('graph-p2-dec', {
        type: 'line',
        data: {
            labels: DEC_SPEED_STEPS,
            datasets: sizes.map(s => ({
                label: s, borderColor: SIZE_COLORS[s] || '#94a3b8',
                backgroundColor: 'transparent', data: avgDecBy(s),
                tension: 0.2, pointRadius: 3,
            })),
        },
        options: { ...CHART_OPTS_BASE,
            scales: {
                x: { title: { display: true, text: 'Decode speed tier' } },
                y: { title: { display: true, text: 'Decode ms' }, beginAtZero: true },
            },
        },
    });
}

function renderP3Charts() {
    const p3 = allResults.filter(r => r.phase === 3);
    if (!p3.length) return;

    const modLabels = { '-1': 'Auto', '0': 'VarDCT', '1': 'Modular' };
    const modColors = { '-1': '#4ade80', '0': '#60a5fa', '1': '#f97316' };
    const brotliLabels = BROTLI_STEPS.map(b => b === -1 ? 'default' : String(b));

    // Average across files for each (modular, brotli) combo → bar per modular, x = brotli
    function avgEncForModular(mod) {
        return BROTLI_STEPS.map(b => {
            const rows = p3.filter(r => r.modular === mod && r.brotli === b);
            if (!rows.length) return null;
            return rows.reduce((s, r) => s + r.encMs, 0) / rows.length;
        });
    }

    upsertChart('graph-p3-mod', {
        type: 'bar',
        data: {
            labels: brotliLabels,
            datasets: MODULAR_STEPS.map(mod => ({
                label: modLabels[String(mod)],
                backgroundColor: modColors[String(mod)] || '#94a3b8',
                data: avgEncForModular(mod),
            })),
        },
        options: { ...CHART_OPTS_BASE,
            scales: {
                x: { title: { display: true, text: 'Brotli effort' } },
                y: { title: { display: true, text: 'Encode ms' }, beginAtZero: true },
            },
        },
    });
}
```

- [ ] **Step 7.2: Commit**

```bash
git add web/jxl-preset-benchmark.js
git commit -m "feat(preset-bench): Chart.js graphs for phases 1-3"
```

---

## Task 8: Preset benchmark — results table + preset cards

**Files:**
- Modify: `web/jxl-preset-benchmark.js` (append)

- [ ] **Step 8.1: Add results table render + sort**

Append to `jxl-preset-benchmark.js`:

```js
// ─── Results table ────────────────────────────────────────────────────────────

const TABLE_COLS = [
    { id: 'file',     label: 'File',   fmt: r => r.file.toUpperCase() },
    { id: 'size',     label: 'Size',   fmt: r => r.size },
    { id: 'tier',     label: 'Tier',   fmt: r => r.tier },
    { id: 'phase',    label: 'Ph',     fmt: r => r.phase },
    { id: 'effort',   label: 'Effort', fmt: r => r.effort },
    { id: 'decSpeed', label: 'DecSpd', fmt: r => r.decSpeed },
    { id: 'modular',  label: 'Mod',    fmt: r => r.modular === -1 ? 'auto' : r.modular },
    { id: 'brotli',   label: 'Brotli', fmt: r => r.brotli  === -1 ? 'def'  : r.brotli  },
    { id: 'resamp',   label: 'Resamp', fmt: r => `${r.resamp}×` },
    { id: 'encMs',    label: 'Enc ms', fmt: r => r.encMs.toFixed(0) },
    { id: 'decMs',    label: 'Dec ms', fmt: r => r.decMs.toFixed(0) },
    { id: 'sizeKb',   label: 'KB',     fmt: r => (r.sizeBytes / 1024).toFixed(0), val: r => r.sizeBytes },
    { id: 'score',    label: 'Score↑', fmt: r => r.score },
];

function sortedResults() {
    const col = TABLE_COLS.find(c => c.id === sortCol) || TABLE_COLS[TABLE_COLS.length - 1];
    const val = col.val ?? (r => r[col.id]);
    return [...allResults].sort((a, b) => {
        const av = val(a), bv = val(b);
        const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
        return sortDir === 'desc' ? -cmp : cmp;
    });
}

function renderTableIncremental() {
    // Only re-render if fewer than 200 rows to avoid jank during sweep
    if (allResults.length > 200) return;
    renderTable();
}

function renderTable() {
    const tbody = document.getElementById('bench-table-body');
    if (!tbody) return;
    const rows = sortedResults();

    // Best row per (tier, size): highest score
    const bestKey = {};
    for (const r of allResults) {
        const k = `${r.tier}_${r.size}`;
        if (!bestKey[k] || r.score > bestKey[k].score) bestKey[k] = r;
    }

    tbody.innerHTML = '';
    for (const r of rows) {
        const k = `${r.tier}_${r.size}`;
        const isBest = bestKey[k] === r;
        const tr = document.createElement('tr');
        if (isBest) tr.classList.add('is-best');
        for (const col of TABLE_COLS) {
            const td = document.createElement('td');
            const txt = col.fmt(r);
            td.textContent = isBest && col.id === 'score' ? `${txt} ★` : txt;
            if (isBest && col.id === 'score') td.classList.add('is-best-cell');
            tr.appendChild(td);
        }
        tbody.appendChild(tr);
    }
    // Update sort header indicators
    document.querySelectorAll('.bench-table th').forEach(th => {
        th.classList.remove('sort-asc', 'sort-desc');
        if (th.dataset.col === sortCol) th.classList.add(sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
    });
}

function wireSortHeaders() {
    document.querySelectorAll('.bench-table th[data-col]').forEach(th => {
        th.addEventListener('click', () => {
            if (sortCol === th.dataset.col) {
                sortDir = sortDir === 'asc' ? 'desc' : 'asc';
            } else {
                sortCol = th.dataset.col;
                sortDir = 'desc';
            }
            renderTable();
        });
    });
}
```

- [ ] **Step 8.2: Add preset derivation and Copy JSON**

Append to `jxl-preset-benchmark.js`:

```js
// ─── Preset derivation ────────────────────────────────────────────────────────

function derivePreset(tierId) {
    const tier = TIERS.find(t => t.id === tierId);
    if (!tier) return null;
    // Use phase 4 rows for this tier (final optimal params); fall back to phase 1 if absent
    const rows = allResults.filter(r => r.tier === tierId && r.phase === 4);
    const base = rows.length ? rows : allResults.filter(r => r.tier === tierId && r.phase === 1);
    if (!base.length) return null;

    // Best row by score across all sizes, then pick modal values
    const sorted = [...base].sort((a, b) => b.score - a.score);
    const best = sorted[0];

    // Build per-size bench stats from phase 4 (or fallback)
    const benchStats = {};
    const sizeGroups = {};
    for (const r of base) (sizeGroups[r.size] = sizeGroups[r.size] || []).push(r);
    const med = arr => [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)];
    for (const [size, sRows] of Object.entries(sizeGroups)) {
        benchStats[size] = {
            avgEncMs:  Math.round(med(sRows.map(r => r.encMs))),
            avgDecMs:  Math.round(med(sRows.map(r => r.decMs))),
            avgSizeKb: Math.round(med(sRows.map(r => r.sizeBytes)) / 1024),
        };
    }

    return {
        tier: tierId,
        quality:       tier.lossless ? 100 : tier.quality,
        lossless:      tier.lossless,
        effort:        best.effort,
        decodingSpeed: best.decSpeed,
        modular:       best.modular,
        brotliEffort:  best.brotli,
        resampling:    best.resamp,
        benchStats,
    };
}

function deriveAndShowPresets() {
    for (const tierId of ['low', 'medium', 'high', 'lossless']) {
        const preset = derivePreset(tierId);
        const paramsEl  = document.getElementById(`preset-params-${tierId}`);
        const timingEl  = document.getElementById(`preset-timing-${tierId}`);
        const copyBtn   = document.getElementById(`preset-copy-${tierId}`);
        if (!preset || !paramsEl) continue;

        paramsEl.textContent = [
            `quality:    ${preset.quality}`,
            `lossless:   ${preset.lossless}`,
            `effort:     ${preset.effort}`,
            `decSpeed:   ${preset.decodingSpeed}`,
            `modular:    ${preset.modular === -1 ? 'auto' : preset.modular}`,
            `brotli:     ${preset.brotliEffort === -1 ? 'default' : preset.brotliEffort}`,
            `resampling: ${preset.resampling}×`,
        ].join('\n');

        const timingLines = Object.entries(preset.benchStats).map(([size, s]) =>
            `${size}: enc ${s.avgEncMs} ms · dec ${s.avgDecMs} ms · ${s.avgSizeKb} KB`
        );
        if (timingEl) timingEl.textContent = timingLines.join('\n');

        if (copyBtn) {
            copyBtn.disabled = false;
            copyBtn.onclick = () => {
                navigator.clipboard.writeText(JSON.stringify(preset, null, 2)).then(() => {
                    copyBtn.textContent = 'Copied!';
                    copyBtn.classList.add('copied');
                    setTimeout(() => { copyBtn.textContent = 'Copy JSON'; copyBtn.classList.remove('copied'); }, 2000);
                });
            };
        }
    }
}

function persistResults() {
    try {
        const payload = { timestamp: Date.now(), results: allResults };
        localStorage.setItem(LS_RESULTS_KEY, JSON.stringify(payload));
    } catch { /* storage full — not critical */ }
}

function loadSavedResults() {
    try {
        const raw = localStorage.getItem(LS_RESULTS_KEY);
        if (!raw) { updateStatusCurrent('No saved results found.'); return; }
        const { timestamp, results } = JSON.parse(raw);
        allResults.length = 0;
        allResults.push(...results);
        rescoreAllResults();
        document.getElementById('bench-table-shell').hidden = false;
        document.getElementById('btn-export-csv').disabled = false;
        renderTable();
        renderP1Charts();
        renderP2Charts();
        renderP3Charts();
        deriveAndShowPresets();
        const age = Math.round((Date.now() - timestamp) / 60000);
        updateStatusCurrent(`Loaded saved results from ${age} min ago (${results.length} rows).`);
    } catch (err) {
        updateStatusCurrent(`Failed to load saved results: ${err?.message}`);
    }
}

function exportCsv() {
    const cols = TABLE_COLS.map(c => c.label);
    const rows = sortedResults().map(r => TABLE_COLS.map(c => {
        const v = (c.val ?? (row => row[c.id]))(r);
        return typeof v === 'string' && v.includes(',') ? `"${v}"` : v;
    }));
    const csv = [cols.join(','), ...rows.map(r => r.join(','))].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `jxl-preset-bench-${Date.now()}.csv`;
    a.click();
}
```

- [ ] **Step 8.3: Commit**

```bash
git add web/jxl-preset-benchmark.js
git commit -m "feat(preset-bench): results table + preset derivation + CSV export"
```

---

## Task 9: Preset benchmark — UI wiring + initialisation

**Files:**
- Modify: `web/jxl-preset-benchmark.js` (append final init block)

- [ ] **Step 9.1: Add button wiring and initialisation**

Append to `jxl-preset-benchmark.js`:

```js
// ─── Run button + controls ────────────────────────────────────────────────────

function updateRunButton() {
    const hasFiles = SLOT_IDS.some(id => sources[id]);
    const btn = document.getElementById('btn-run');
    if (btn) btn.disabled = !hasFiles || sweepRunning;
}

// ─── Init ─────────────────────────────────────────────────────────────────────

await initRaw();

// Open IDB; non-fatal if unavailable
db = await openIdb().catch(err => {
    dbgLog(`[idb] unavailable: ${err?.message}`, '', 'error');
    return null;
});

// Wire file slots
for (const slotId of SLOT_IDS) wireFileSlot(slotId);

// Restore persisted files
await restoreFromIdb();

// Wire sweep controls
document.getElementById('btn-run')?.addEventListener('click', () => {
    runSweep().catch(err => updateStatusCurrent(`Sweep failed: ${err?.message}`));
});
document.getElementById('btn-stop')?.addEventListener('click', () => {
    sweepAborted = true;
    updateStatusCurrent('Stopping after current run…');
});
document.getElementById('btn-load-saved')?.addEventListener('click', loadSavedResults);
document.getElementById('btn-export-csv')?.addEventListener('click', exportCsv);

// Wire debug console
const consoleBtn = document.getElementById('btn-console');
if (consoleBtn) initDebugConsole(consoleBtn);

// Wire sort headers
wireSortHeaders();

// Restore saved results if present (show last sweep without re-running)
loadSavedResults();
```

- [ ] **Step 9.2: Full end-to-end test**

1. Open `http://localhost:PORT/jxl-preset-benchmark.html`
2. Drop `P1110226.ORF` onto the ORF slot — filename badge appears, no errors
3. Reload page — ORF slot shows restored filename automatically
4. Drop `P1110226 windows.jpg` onto JPEG slot
5. Uncheck High + Lossless tiers; uncheck 1920px + Full sizes
6. Set Runs/config = 1
7. Click Run sweep
8. Verify: phase cards activate in sequence, status ticker updates each run, graphs appear
9. When complete: preset cards show populated params, Copy JSON copies valid JSON to clipboard
10. Click Export CSV — file downloads
11. Click Load saved — same results re-appear after a page reload

- [ ] **Step 9.3: Commit**

```bash
git add web/jxl-preset-benchmark.js
git commit -m "feat(preset-bench): init, button wiring, IDB restore — full integration"
```

---

## Self-Review Notes

**Spec coverage check:**
- ✅ CR2 WASM export (`process_cr2` + `process_cr2_with_flags`) — Task 1
- ✅ WASM rebuild — Task 1 Step 1.2
- ✅ Wrapper-lab brotliEffort + modular — Task 2
- ✅ Wrapper-lab CR2 file handling — Task 3
- ✅ 5-slot file intake with IDB persistence — Tasks 4, 5
- ✅ Phased sweep engine (4 phases) — Task 6
- ✅ Knee-point algorithm — Task 6 Step 6.2
- ✅ Sequential runs with abort — Task 6 Step 6.3
- ✅ Chart.js graphs (4 charts, phases 1–3) — Task 7
- ✅ Results table with sort — Task 8 Step 8.1
- ✅ Preset derivation + Copy JSON — Task 8 Step 8.2
- ✅ localStorage persistence for results — Task 8 Step 8.2
- ✅ Nav links — Task 4 Step 4.4
- ✅ Console button — Task 9 Step 9.1
- ✅ Live status ticker — Task 6 Steps 6.1 and 6.3

**Type consistency confirmed:**
- `sources[slotId]` shape: `{ name, rgba: Uint8Array, width, height }` — used consistently in Tasks 5, 6
- `SweepRow` shape: `{ file, size, tier, phase, effort, decSpeed, modular, brotli, resamp, encMs, decMs, sizeBytes, score }` — defined in Task 6, consumed in Tasks 7, 8
- `bestParams` shape: `{ effort: {[sizeLabel]: number}, decSpeed: {[sizeLabel]: number}, modular: number, brotli: number }` — built through Tasks 6.3 phases 1–4
- `IDB record` shape: `{ name: string, bytes: Uint8Array, ext: string }` — matches spec

**Potential issue flagged:** `resizeSource` calls `rawWasm.downscale_rgba` which takes `(rgba, width, height, tw, th)`. The function signature on the WASM export is `downscale_rgba(rgba, src_width, src_height, dst_width, dst_height)`. Confirm parameter order matches `src/lib.rs:715` before running the sweep. If signature differs, the canvas fallback (`downscaleRgbaCanvas`) handles it identically.
