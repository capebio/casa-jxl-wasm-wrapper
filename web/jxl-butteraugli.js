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

// Convert RGBA uint8 pixels → XYB float32 channels (allocation-free variant).
// outX, outY, outB must be pre-allocated Float32Arrays of size n.
export function pixelsToXybInto(pixels, n, outX, outY, outB) {
    // Guard the stride invariant: the loop reads pixels[j..j+2] up to j=(n-1)*4,
    // so pixels must hold at least n*4 bytes (RGBA stride). Reading past the end
    // would silently yield undefined → NaN channels.
    if (pixels.length < n * 4) {
        throw new RangeError(`pixelsToXyb: pixels.length (${pixels.length}) < n*4 (${n * 4})`);
    }
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
// pixels: Uint8Array RGBA (stride 4, alpha ignored). For batch reuse see createButteraugliComparer.
// Approx only; not bit-exact libjxl.
// Optional outX/outY/outB for zero-alloc in hot batch paths.
export function pixelsToXyb(pixels, n, outX, outY, outB) {
    const X = outX || new Float32Array(n);
    const Y = outY || new Float32Array(n);
    const B = outB || new Float32Array(n);
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
        for (let k = 1; k <= r; k++) sum += src[base + Math.min(k, w - 1)];
        for (let x = 0; x < w; x++) {
            tmp[base + x] = sum * inv;
            sum += src[base + Math.min(x + r + 1, w - 1)]
                 - src[base + Math.max(x - r, 0)];
        }
    }

    // Vertical pass — sliding window
    for (let x = 0; x < w; x++) {
        let sum = tmp[x] * (r + 1);
        for (let k = 1; k <= r; k++) sum += tmp[Math.min(k, h - 1) * w + x];
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
// dst must be a pre-allocated Float32Array of size Math.max(1,w>>1) × Math.max(1,h>>1).
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

// 2× area downsample (box filter) — allocates new buffer. Returns [dst, dw, dh].
function dn2(src, w, h) {
    const dw = Math.max(1, w >> 1);
    const dh = Math.max(1, h >> 1);
    const dst = new Float32Array(dw * dh);
    return dn2Into(src, dst, w, h);
}

// Reference-side work is identical for every pass compared against the same
// reference: the 3-scale downsampled pyramid of the ref channels and the masking
// blur of ref Y. Charts evaluate many passes per reference, so precompute once,
// keyed on the refXyb array identity (WeakMap — GC-safe, zero API change).
const _refPrep = new WeakMap();

function prepRef(refXyb, width, height) {
    const cached = _refPrep.get(refXyb);
    if (cached && cached.width === width && cached.height === height) return cached;
    let [X, Y, B] = refXyb;
    let w = width, h = height;
    const levels = [];
    for (let s = 0; s < 3; s++) {
        const prev = levels[levels.length - 1];
        if (prev && prev.X === X) {
            levels.push(prev);  // degenerate 1px dims: scale not downsampled, reuse level
        } else {
            const blurR = Math.max(1, Math.min(8, w >> 6));  // ~w/64, clamped 1–8
            levels.push({ X, Y, B, mask: boxBlur(Y, w, h, blurR) });
        }
        if (s < 2 && w > 1 && h > 1) {
            X = dn2(X, w, h)[0];
            Y = dn2(Y, w, h)[0];
            B = dn2(B, w, h)[0];
            w = Math.max(1, w >> 1);
            h = Math.max(1, h >> 1);
        }
    }
    const prep = { width, height, levels };
    _refPrep.set(refXyb, prep);
    return prep;
}

// Perceptual error at one spatial scale.
// mask: precomputed box blur of the reference Y channel (brighter/higher-contrast
// areas tolerate more error) — constant per reference, see prepRef().
// k: optional per-channel weight overrides {kX, kY, kB}; defaults: kX=24 kY=12 kB=4.
function scaleErr(mask, rX, rY, rB, tX, tY, tB, w, h, k = null) {
    const n = w * h;
    const kX = (k && k.kX) || 24, kY = (k && k.kY) || 12, kB = (k && k.kB) || 4;
    let sum = 0;
    for (let i = 0; i < n; i++) {
        const m = Math.max(0.15, mask[i] * 2.0 + 0.15);
        const ex = (rX[i] - tX[i]) / m;
        const ey = (rY[i] - tY[i]) / m;
        const eb = (rB[i] - tB[i]) / m;
        const e2 = kX * ex * ex + kY * ey * ey + kB * eb * eb;
        sum += e2 * Math.sqrt(e2 + 1e-12);  // branchless e2^1.5 (p=3)
    }
    return (sum / n) ** (1 / 3);
}

// createButteraugliComparer: factory with pre-allocated test buffers.
// Cuts alloc/GC for repeated cutoff evals vs same ref. Keeps old compute* API unchanged.
// opts: {weights?, k? {kX,kY,kB}, includeGradient?} for lens15/17/14 tuning.
export function createButteraugliComparer(refPixels, width, height, opts = {}) {
    const n = width * height;
    if (!n || refPixels.length !== n * 4) return () => NaN;
    const refXyb = pixelsToXyb(refPixels, n);
    const prep = prepRef(refXyb, width, height);
    const maxN = n;
    let tX = new Float32Array(maxN), tY = new Float32Array(maxN), tB = new Float32Array(maxN);
    let dX = new Float32Array(maxN), dY = new Float32Array(maxN), dB = new Float32Array(maxN);
    const weights = opts.weights || [4, 2, 1];
    const k = opts.k || null;
    const includeGradient = !!opts.includeGradient;
    return function computeVsFinal(testPixels) {
        if (testPixels.length !== n * 4) return NaN;
        pixelsToXyb(testPixels, n, tX, tY, tB);

        let w = width, h = height, total = 0;
        for (let s = 0; s < 3; s++) {
            const L = prep.levels[s];
            let e = scaleErr(L.mask, L.X, L.Y, L.B, tX, tY, tB, w, h, k) * weights[s];
            if (includeGradient) {
                // stub: sobel/gradient term on Y for photogram feature stability (lens14)
                e *= 1.0;
            }
            total += e;
            if (s < 2 && w > 1 && h > 1) {
                const dw = Math.max(1, w >> 1), dh = Math.max(1, h >> 1), dn = dw * dh;
                for (let y = 0; y < dh; y++) {
                    const sy0 = y << 1, sy1 = Math.min(sy0 + 1, h - 1);
                    for (let x = 0; x < dw; x++) {
                        const sx0 = x << 1, sx1 = Math.min(sx0 + 1, w - 1);
                        const idx = y * dw + x;
                        const bo0 = sy0 * w + sx0, bo1 = sy0 * w + sx1, b10 = sy1 * w + sx0, b11 = sy1 * w + sx1;
                        dX[idx] = (tX[bo0] + tX[bo1] + tX[b10] + tX[b11]) * 0.25;
                        dY[idx] = (tY[bo0] + tY[bo1] + tY[b10] + tY[b11]) * 0.25;
                        dB[idx] = (tB[bo0] + tB[bo1] + tB[b10] + tB[b11]) * 0.25;
                    }
                }
                tX.set(dX.subarray(0, dn));
                tY.set(dY.subarray(0, dn));
                tB.set(dB.subarray(0, dn));
                w = dw; h = dh;
            }
        }
        return total / 7;
    };
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

// Compute Butteraugli-inspired score.
//
// refXyb: result of pixelsToXyb(refPixels, n) — precompute once, reuse per pass.
// testPixels: Uint8Array of RGBA bytes for the pass being compared.
//
// Returns a non-negative float; 0 = identical, ~0.5 = excellent, >1.5 = visible.
// For batch/repeated use (zero-alloc, config) use createButteraugliComparer instead.
export function computeButteraugliVsFinal(refXyb, testPixels, width, height) {
    // Validate dimensions BEFORE dispatching to either backend so the WASM path
    // is guarded identically to the JS path (was previously unchecked, passing
    // mismatched buffers straight into native code).
    const n = width * height;
    if (!n || testPixels.length !== n * 4) return NaN;

    if (_backend.score) {
        return _backend.score(refXyb, testPixels, width, height);
    }

    const ref = prepRef(refXyb, width, height);
    let [tX, tY, tB] = pixelsToXyb(testPixels, n);
    let w = width, h = height;

    const weights = [4, 2, 1];
    let total = 0;

    for (let s = 0; s < 3; s++) {
        const L = ref.levels[s];
        total += scaleErr(L.mask, L.X, L.Y, L.B, tX, tY, tB, w, h) * weights[s];
        if (s < 2 && w > 1 && h > 1) {
            tX = dn2(tX, w, h)[0];
            tY = dn2(tY, w, h)[0];
            tB = dn2(tB, w, h)[0];
            w = Math.max(1, w >> 1);
            h = Math.max(1, h >> 1);
        }
    }

    return total / 7;
}

// 1-scale fast approx (full weight only). For coarse param sweeps / early reject in profiling.
// Still uses ref prep cache. For config use the comparer path.
export function computeButteraugliApproxVsFinal(refXyb, testPixels, width, height) {
    const n = width * height;
    if (!n || testPixels.length !== n * 4) return NaN;
    const ref = prepRef(refXyb, width, height);
    const L = ref.levels[0];
    const [tX, tY, tB] = pixelsToXyb(testPixels, n);
    return scaleErr(L.mask, L.X, L.Y, L.B, tX, tY, tB, width, height) * 4 / 7;
}

// Future (Lens17/12/16/14): Rust LookRenderer PerceptualConstancy (schrodinger geodesic + molchanov + losalamos)
// will allow illum-invariant sat/wb/exposure in progressive paints. Call these metrics (or comparer)
// on post-adjust RGBA during cutoff evals to validate early "recognizable" under varying illum.
// For LLM/plantID/AR: pass external model score series to byte-metrics for task-aware cutoff (not pixel fidelity).
// Photogram/digital-twin: consider adding gradient term to scaleErr for feature stability.

// Multi-scale score on pre-converted XYB channel arrays.
// Used by computeButteraugliRegion (operating on extracted sub-region arrays, no WeakMap cache).
function _multiScaleScore(rX, rY, rB, tX, tY, tB, w, h, mask0 = null) {
    const weights = [4, 2, 1];
    let total = 0;
    for (let s = 0; s < 3; s++) {
        const blurR = Math.max(1, Math.min(8, w >> 6));
        // s=0 runs at full scale; the caller (computeButteraugliRegion) has already
        // computed this exact blur (same rY/w/h/blurR) for the max-error scan, so reuse
        // it instead of recomputing one full-resolution separable blur.
        const mask = (s === 0 && mask0) ? mask0 : boxBlur(rY, w, h, blurR);
        total += scaleErr(mask, rX, rY, rB, tX, tY, tB, w, h) * weights[s];
        if (s < 2 && w > 1 && h > 1) {
            let nw, nh;
            [rX, nw, nh] = dn2(rX, w, h);
            [rY] = dn2(rY, w, h);
            [rB] = dn2(rB, w, h);
            [tX] = dn2(tX, w, h);
            [tY] = dn2(tY, w, h);
            [tB] = dn2(tB, w, h);
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

    // Compute mask from reference Y at full scale for max-error pixel location.
    const blurR = Math.max(1, Math.min(8, width >> 6));
    const mask = boxBlur(rY, width, height, blurR);

    // Find max per-pixel error at full resolution so callers can locate hotspots.
    const kX = 24, kY = 12, kB = 4;
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

    const score = _multiScaleScore(rX, rY, rB, tX, tY, tB, width, height, mask);
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
