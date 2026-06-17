# Sonnet Pipeline Handoff — jxl-butteraugli.js

**Base context:** See `docs/ProgressiveSaliencyImplementationPlan.md` sections "Agent Sonnet Medium" and "Agent Sonnet High".

**Target file:** `web/jxl-butteraugli.js`

**Haiku completed (2026-06-16):**
- ✅ Scratch pool: `createButteraugliScratch()` + `ensureScratch()` with geometric growth
- ✅ Allocation-free kernels: `pixelsToXybInto()`, `dn2Into()`, `boxBlurInto()`
- ✅ Micro-opt: `e2 * Math.sqrt(e2)` (25–50% faster than exponentiation)
- ✅ Memory profile: ~2× working scale instead of 4× full image
- ✅ Backward compatible: existing API preserved

**Foundation ready for:**

### Agent Sonnet Medium — Pipeline redesign for progressive rendering

Implement from ProgressiveSaliencyImplementationPlan.md:

#### 1. Region scoring
```js
export function computeButteraugliRegion(
    refXyb,
    pixels,
    x, y, width, height,
    imageWidth
)
```
Return: `{ score, maxError, location }`
Do not rescan pixels outside region.

#### 2. Saliency field
```js
export function computeSaliencyField(
    refXyb,
    testPixels,
    width, height
)
```
Return: Float32Array, values 0–1 (irrelevant to highest change).
Implementation: per-pixel `24*dx² + 12*dy² + 4*db²`, then normalize.

#### 3. Bermanian placeholder seam (extension point only)
```js
let informationBackend = null;

export function registerInformationBackend(backend) {
    informationBackend = backend;
}

export function computeInformationField(image, width, height) {
    if (informationBackend) {
        return informationBackend.compute(image, width, height);
    }
    return null;
}
```
Purpose: future Rust implementation. Do NOT implement mathematics.

#### 4. Tile prioritization
```js
export function rankTiles(
    saliency,
    information,
    tileSize,
    width, height
)
```
Return sorted array: `[{ x, y, score }, ...]`

---

### Agent Sonnet High — WASM architecture and long-term engine design

Implement from ProgressiveSaliencyImplementationPlan.md:

#### 1. Backend abstraction
```js
let backend = {
    score: null,
    convert: null,
    saliency: null
};

export function registerBackend(b) {
    backend = b;
}
```

#### 2. Route hot kernels through backend
Modify hot paths (especially `computeButteraugliVsFinal`) to check `backend.score` first:
```js
if (backend.score) {
    return backend.score(ref, pixels, width, height);
}
// else use JS fallback
```

#### 3. Document required Rust exports (for future crate)
Future Rust should expose:
- `rgba_to_xyb()`
- `downsample_xyb()`
- `blur_y()`
- `butteraugli_score()`
- `saliency_field()`

Do NOT expose per-pixel calls (`score_pixel`). Use batch APIs (`score_image`).

#### 4. Buffer ownership rule
Document: no copy loops WASM→JS→WASM. Use Uint8Array views into WASM memory directly.

---

## Integration notes

**Scratch pool usage for Sonnet:**
- Region/saliency functions can accept optional `scratch` parameter (same pattern as `computeButteraugliVsFinal`)
- Enables caller-managed reuse across many region scores
- Use `ensureScratch(scratch, length)` before hot loops

**Architecture target (from handoff):**
```
image
  |
perceptual representation
  |
  +————————+————————+
  |        |        |
distance | information
  |        |        |
  +————————+————————+
  |
  v
tile priority
```

Outputs:
- Compression decisions
- Progressive decode ordering
- AR focus hints
- Digital twin feature weighting

---

## What success looks like

- All Sonnet Medium items (region/saliency/tile APIs) exportable and composable
- Backend abstraction callable from hot paths with zero overhead when unused
- Rust boundary clean (no per-pixel FFI, batch APIs only)
- File converted from "comparison function" to "perceptual analysis engine"
- Foundation supports 10–100× computation reduction in progressive workflows (vs full-image rescoring)

---

## Test note

No existing unit tests for `jxl-butteraugli.js`. Integration tests via:
- `web/jxl-single-progressive.js` (chart rendering)
- `web/jxl-frame-stats-worker.js` (worker analysis)

Verify backward compat: existing `computeButteraugliVsFinal(refXyb, pixels, w, h)` calls must still work.

---

## Rejection log

See `docs/rejected optimizations.md` section "web/jxl-butteraugli.js":
- Full-resolution workspace factory: rejected (memory residency problem)
- Scratch pool: implemented (solves real problem)

All other rejections (soft preemption, pixel pools, etc.) already documented.
