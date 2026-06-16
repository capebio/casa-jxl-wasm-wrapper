// Butteraugli-inspired perceptual image distance (JS approximation)
// Not bit-exact with libjxl. Score: lower = better; 0 = identical; ~1.0 = visible.
//
// Algorithm:
//  1. sRGB → linear → XYB (opponent-color space used by Butteraugli/JXL)
//  2. Multi-scale spatial masking via box blur of Y channel
//  3. Weighted per-channel error with p-norm (p=3) at 3 octaves
//  4. Combine scales: full (×4) + half (×2) + quarter (×1) / 7

// Precomputed table: sqrt(sRGB_decode(i/255)) — avoids per-pixel gamma + sqrt calls
const _sqrtLin = (() => {
    const t = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
        const v = i / 255;
        const lin = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        t[i] = Math.sqrt(lin);
    }
    return t;
})();

// Reusable scratch buffer pool with geometric growth.
// Adapts to working region size; zero allocations after first ensureScratch call.
export function createButteraugliScratch() {
    return {
        a: null,
        b: null,
        c: null,
        capacity: 0
    };
}

// Grow scratch buffers geometrically if needed. Does nothing if capacity is sufficient.
function ensureScratch(scratch, length) {
    if (scratch.capacity >= length) return;

    const next = Math.ceil(Math.max(length, scratch.capacity * 1.5));
    scratch.a = new Float32Array(next);
    scratch.b = new Float32Array(next);
    scratch.c = new Float32Array(next);
    scratch.capacity = next;
}

// Convert RGBA uint8 pixels → XYB float32 channels (allocation-free variant).
// outX, outY, outB must be pre-allocated Float32Arrays of size n.
export function pixelsToXybInto(pixels, n, outX, outY, outB) {
    for (let i = 0, j = 0; i < n; i++, j += 4) {
        const r = _sqrtLin[pixels[j]];
        const g = _sqrtLin[pixels[j + 1]];
        const b = _sqrtLin[pixels[j + 2]];
        outX[i] = (r - b) * 0.5;        // red–blue opponent
        outY[i] = (r + b) * 0.5 + g;   // luminance proxy
        outB[i] = b;                     // blue channel
    }
}

// Convert RGBA uint8 pixels → XYB float32 channels.
// Exported so callers can precompute reference once and reuse across passes.
export function pixelsToXyb(pixels, n) {
    const X = new Float32Array(n);
    const Y = new Float32Array(n);
    const B = new Float32Array(n);
    pixelsToXybInto(pixels, n, X, Y, B);
    return [X, Y, B];
}

// O(n) separable box blur into pre-allocated buffers (allocation-free variant).
// tmp and dst must be pre-allocated Float32Arrays of size w*h.
function boxBlurInto(src, dst, tmp, w, h, r) {
    const inv = 1.0 / (2 * r + 1);

    // Horizontal pass — sliding window
    for (let y = 0; y < h; y++) {
        const base = y * w;
        let sum = src[base] * (r + 1);
        for (let k = 1; k <= r; k++) sum += src[base + k];
        for (let x = 0; x < w; x++) {
            tmp[base + x] = sum * inv;
            sum += src[base + Math.min(x + r + 1, w - 1)]
                 - src[base + Math.max(x - r, 0)];
        }
    }

    // Vertical pass — sliding window
    for (let x = 0; x < w; x++) {
        let sum = tmp[x] * (r + 1);
        for (let k = 1; k <= r; k++) sum += tmp[k * w + x];
        for (let y = 0; y < h; y++) {
            dst[y * w + x] = sum * inv;
            sum += tmp[Math.min(y + r + 1, h - 1) * w + x]
                 - tmp[Math.max(y - r, 0) * w + x];
        }
    }

    return dst;
}

// O(n) separable box blur, clamp-to-edge boundary — allocates buffers.
function boxBlur(src, w, h, r) {
    const n = w * h;
    const tmp = new Float32Array(n);
    const dst = new Float32Array(n);
    return boxBlurInto(src, dst, tmp, w, h, r);
}

// 2× area downsample into pre-allocated buffer (allocation-free variant).
// dst must be a pre-allocated Float32Array of size Math.max(1, w>>1) × Math.max(1, h>>1).
function dn2Into(src, dst, w, h) {
    const dw = Math.max(1, w >> 1);
    const dh = Math.max(1, h >> 1);
    for (let y = 0; y < dh; y++) {
        const sy0 = y << 1;
        const sy1 = Math.min(sy0 + 1, h - 1);
        for (let x = 0; x < dw; x++) {
            const sx0 = x << 1;
            const sx1 = Math.min(sx0 + 1, w - 1);
            dst[y * dw + x] = (
                src[sy0 * w + sx0] + src[sy0 * w + sx1] +
                src[sy1 * w + sx0] + src[sy1 * w + sx1]
            ) * 0.25;
        }
    }
    return [dst, dw, dh];
}

// 2× area downsample (box filter) — allocates new buffer.
function dn2(src, w, h) {
    const dw = Math.max(1, w >> 1);
    const dh = Math.max(1, h >> 1);
    const dst = new Float32Array(dw * dh);
    return dn2Into(src, dst, w, h);
}

// Perceptual error at one spatial scale.
// Uses Y-channel blur for masking (brighter/higher-contrast areas tolerate more error).
// scratch: pre-allocated buffers from createButteraugliScratch(), sized to w*h.
function scaleErr(rX, rY, rB, tX, tY, tB, w, h, scratch) {
    const blurR = Math.max(1, Math.min(8, w >> 6));  // ~w/64, clamped 1–8
    const n = w * h;
    ensureScratch(scratch, n);
    const mask = boxBlurInto(rY, scratch.a, scratch.b, w, h, blurR);
    // Per-channel weights: opponent (X) highest, luminance (Y) mid, blue (B) lowest
    const kX = 24, kY = 12, kB = 4;
    let sum = 0;
    for (let i = 0; i < n; i++) {
        const m = Math.max(0.15, mask[i] * 2.0 + 0.15);
        const ex = (rX[i] - tX[i]) / m;
        const ey = (rY[i] - tY[i]) / m;
        const eb = (rB[i] - tB[i]) / m;
        const e2 = kX * ex * ex + kY * ey * ey + kB * eb * eb;
        if (e2 > 1e-9) sum += e2 * Math.sqrt(e2);  // e2^1.5 = e2 * sqrt(e2)
    }
    return (sum / n) ** (1 / 3);  // p=3 → 1/p=1/3
}

// Compute Butteraugli-inspired score with scratch pool for memory efficiency.
//
// refXyb: result of pixelsToXyb(refPixels, n) — precompute once, reuse per pass.
// testPixels: Uint8Array of RGBA bytes for the pass being compared.
// scratch: optional pre-allocated scratch buffers from createButteraugliScratch();
//          if omitted, created internally (one allocation per score).
//
// Returns a non-negative float; 0 = identical, ~0.5 = excellent, >1.5 = visible.
export function computeButteraugliVsFinal(refXyb, testPixels, width, height, scratch) {
    if (_backend.score) {
        return _backend.score(refXyb, testPixels, width, height);
    }
    const n = width * height;
    if (!n || testPixels.length !== n * 4) return NaN;

    const ownsScratch = !scratch;
    scratch = scratch || createButteraugliScratch();

    let [rX, rY, rB] = refXyb;
    let [tX, tY, tB] = pixelsToXyb(testPixels, n);
    let w = width, h = height;

    const weights = [4, 2, 1];
    let total = 0;

    for (let s = 0; s < 3; s++) {
        total += scaleErr(rX, rY, rB, tX, tY, tB, w, h, scratch) * weights[s];
        if (s < 2 && w > 1 && h > 1) {
            const nw = Math.max(1, w >> 1);
            const nh = Math.max(1, h >> 1);
            const nsize = nw * nh;
            ensureScratch(scratch, nsize);

            // Downsample via scratch buffers; pointer-swap to avoid extra allocations
            dn2Into(rX, scratch.a, w, h);
            dn2Into(rY, scratch.b, w, h);
            dn2Into(rB, scratch.c, w, h);
            rX = scratch.a; rY = scratch.b; rB = scratch.c;

            dn2Into(tX, scratch.a, w, h);
            dn2Into(tY, scratch.b, w, h);
            dn2Into(tB, scratch.c, w, h);
            tX = scratch.a; tY = scratch.b; tB = scratch.c;

            w = nw; h = nh;
        }
    }

    return total / 7;
}

// =============================================================================
// Backend abstraction — routes hot kernels through WASM when registered.
//
// Buffer ownership rule: no copy loops WASM→JS→WASM. Pass Uint8Array views
// into WASM heap memory (pointer + length) for zero-copy access.
//
// Required Rust exports (batch APIs only — no per-pixel FFI):
//   rgba_to_xyb(pixels: *const u8, n: usize) -> *mut [f32; 3]
//   downsample_xyb(ch: *mut f32, w: u32, h: u32) -> *mut f32
//   blur_y(y: *const f32, w: u32, h: u32, r: u32) -> *mut f32
//   butteraugli_score(ref_xyb: *const f32, test_xyb: *const f32, w: u32, h: u32) -> f32
//   saliency_field(ref_xyb: *const f32, test_xyb: *const f32, n: usize, out: *mut f32)
let _backend = { score: null, convert: null, saliency: null };

export function registerBackend(b) {
    _backend = b;
}

// Bermanian extension point — future Rust information-theoretic saliency.
// Do NOT implement mathematics here; this is a seam for the Rust crate only.
let _informationBackend = null;

export function registerInformationBackend(backend) {
    _informationBackend = backend;
}

export function computeInformationField(image, width, height) {
    if (_informationBackend) {
        return _informationBackend.compute(image, width, height);
    }
    return null;
}

// Multi-scale score on pre-converted XYB channel arrays (correct, no aliasing).
// Uses allocating dn2() for downsampled scales — regions are small so this is fine.
function _multiScaleScore(rX, rY, rB, tX, tY, tB, w, h) {
    const scratch = createButteraugliScratch();
    const weights = [4, 2, 1];
    let total = 0;
    for (let s = 0; s < 3; s++) {
        total += scaleErr(rX, rY, rB, tX, tY, tB, w, h, scratch) * weights[s];
        if (s < 2 && w > 1 && h > 1) {
            const [rXd, nw, nh] = dn2(rX, w, h);
            const [rYd] = dn2(rY, w, h);
            const [rBd] = dn2(rB, w, h);
            const [tXd] = dn2(tX, w, h);
            const [tYd] = dn2(tY, w, h);
            const [tBd] = dn2(tB, w, h);
            rX = rXd; rY = rYd; rB = rBd;
            tX = tXd; tY = tYd; tB = tBd;
            w = nw; h = nh;
        }
    }
    return total / 7;
}

// Score a sub-region of the image without scanning pixels outside it.
//
// refXyb: full-image result of pixelsToXyb() (stride = imageWidth).
// pixels: full-image RGBA Uint8Array (stride = imageWidth * 4).
// x, y, width, height: region bounds (pixels, 0-indexed).
// imageWidth: full-image pixel width (stride for both arrays).
//
// Returns { score, maxError, location: { x, y } } where location is the
// image-coordinate of the pixel with the highest masked error at full scale.
export function computeButteraugliRegion(refXyb, pixels, x, y, width, height, imageWidth) {
    const n = width * height;
    if (!n) return { score: 0, maxError: 0, location: { x, y } };

    const [fullRX, fullRY, fullRB] = refXyb;

    const rX = new Float32Array(n);
    const rY = new Float32Array(n);
    const rB = new Float32Array(n);
    const tX = new Float32Array(n);
    const tY = new Float32Array(n);
    const tB = new Float32Array(n);

    for (let py = 0; py < height; py++) {
        const srcRow = (y + py) * imageWidth;
        const dstRow = py * width;
        for (let px = 0; px < width; px++) {
            const si = srcRow + (x + px);
            const di = dstRow + px;
            rX[di] = fullRX[si];
            rY[di] = fullRY[si];
            rB[di] = fullRB[si];

            const pi = si * 4;
            const r = _sqrtLin[pixels[pi]];
            const g = _sqrtLin[pixels[pi + 1]];
            const b = _sqrtLin[pixels[pi + 2]];
            tX[di] = (r - b) * 0.5;
            tY[di] = (r + b) * 0.5 + g;
            tB[di] = b;
        }
    }

    // Find max per-pixel error at full resolution so callers can locate hotspots.
    const kX = 24, kY = 12, kB = 4;
    const maskScratch = createButteraugliScratch();
    const blurR = Math.max(1, Math.min(8, width >> 6));
    ensureScratch(maskScratch, n);
    const mask = boxBlurInto(rY, maskScratch.a, maskScratch.b, width, height, blurR);

    let maxError = 0, maxPy = 0, maxPx = 0;
    for (let i = 0; i < n; i++) {
        const m = Math.max(0.15, mask[i] * 2.0 + 0.15);
        const ex = (rX[i] - tX[i]) / m;
        const ey = (rY[i] - tY[i]) / m;
        const eb = (rB[i] - tB[i]) / m;
        const e2 = kX * ex * ex + kY * ey * ey + kB * eb * eb;
        const err = e2 > 1e-9 ? e2 * Math.sqrt(e2) : 0;
        if (err > maxError) {
            maxError = err;
            maxPy = Math.floor(i / width);
            maxPx = i % width;
        }
    }

    const score = _multiScaleScore(rX, rY, rB, tX, tY, tB, width, height);
    return { score, maxError, location: { x: x + maxPx, y: y + maxPy } };
}

// Per-pixel perceptual saliency: how much each pixel differs from the reference.
//
// refXyb: result of pixelsToXyb(refPixels, n) — precompute once, reuse across passes.
// testPixels: Uint8Array of RGBA bytes for the pass being compared.
//
// Returns Float32Array of length width*height, values normalized 0 (same) → 1 (max change).
// Formula: 24*dx² + 12*dy² + 4*db² per pixel, then normalize by max.
export function computeSaliencyField(refXyb, testPixels, width, height) {
    if (_backend.saliency) {
        return _backend.saliency(refXyb, testPixels, width, height);
    }

    const n = width * height;
    const [rX, rY, rB] = refXyb;
    const [tX, tY, tB] = pixelsToXyb(testPixels, n);

    const out = new Float32Array(n);
    let maxVal = 0;

    for (let i = 0; i < n; i++) {
        const dx = rX[i] - tX[i];
        const dy = rY[i] - tY[i];
        const db = rB[i] - tB[i];
        const v = 24 * dx * dx + 12 * dy * dy + 4 * db * db;
        out[i] = v;
        if (v > maxVal) maxVal = v;
    }

    if (maxVal > 0) {
        const inv = 1 / maxVal;
        for (let i = 0; i < n; i++) out[i] *= inv;
    }

    return out;
}

// Rank image tiles by perceptual importance (descending score).
//
// saliency: Float32Array from computeSaliencyField(), length = width*height.
// information: Float32Array from computeInformationField(), same length, or null.
// tileSize: tile edge in pixels (tiles are tileSize×tileSize; edge tiles are smaller).
//
// Returns sorted array: [{ x, y, score }, ...], highest score first.
// Tile score = average saliency (+ average information if provided, weighted 50/50).
export function rankTiles(saliency, information, tileSize, width, height) {
    const tilesX = Math.ceil(width / tileSize);
    const tilesY = Math.ceil(height / tileSize);
    const tiles = [];

    for (let ty = 0; ty < tilesY; ty++) {
        for (let tx = 0; tx < tilesX; tx++) {
            const x0 = tx * tileSize;
            const y0 = ty * tileSize;
            const x1 = Math.min(x0 + tileSize, width);
            const y1 = Math.min(y0 + tileSize, height);

            let salSum = 0, infoSum = 0, count = 0;
            for (let py = y0; py < y1; py++) {
                const row = py * width;
                for (let px = x0; px < x1; px++) {
                    const idx = row + px;
                    salSum += saliency[idx];
                    if (information !== null) infoSum += information[idx];
                    count++;
                }
            }

            const salScore = count > 0 ? salSum / count : 0;
            const score = (information !== null && count > 0)
                ? 0.5 * salScore + 0.5 * infoSum / count
                : salScore;

            tiles.push({ x: x0, y: y0, score });
        }
    }

    tiles.sort((a, b) => b.score - a.score);
    return tiles;
}
