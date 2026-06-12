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

// Convert RGBA uint8 pixels → XYB float32 channels.
// Exported so callers can precompute reference once and reuse across passes.
export function pixelsToXyb(pixels, n) {
    const X = new Float32Array(n);
    const Y = new Float32Array(n);
    const B = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
        const r = _sqrtLin[pixels[j]];
        const g = _sqrtLin[pixels[j + 1]];
        const b = _sqrtLin[pixels[j + 2]];
        X[i] = (r - b) * 0.5;        // red–blue opponent
        Y[i] = (r + b) * 0.5 + g;   // luminance proxy
        B[i] = b;                     // blue channel
    }
    return [X, Y, B];
}

// O(n) separable box blur, clamp-to-edge boundary.
function boxBlur(src, w, h, r) {
    const n = w * h;
    const tmp = new Float32Array(n);
    const dst = new Float32Array(n);
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

// 2× area downsample (box filter)
function dn2(src, w, h) {
    const dw = Math.max(1, w >> 1);
    const dh = Math.max(1, h >> 1);
    const dst = new Float32Array(dw * dh);
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

// Perceptual error at one spatial scale.
// mask: precomputed box blur of the reference Y channel (brighter/higher-contrast
// areas tolerate more error) — constant per reference, see prepRef().
function scaleErr(mask, rX, rY, rB, tX, tY, tB, w, h) {
    const n = w * h;
    const p = 3.0;
    // Per-channel weights: opponent (X) highest, luminance (Y) mid, blue (B) lowest
    const kX = 24, kY = 12, kB = 4;
    let sum = 0;
    for (let i = 0; i < n; i++) {
        const m = Math.max(0.15, mask[i] * 2.0 + 0.15);
        const ex = (rX[i] - tX[i]) / m;
        const ey = (rY[i] - tY[i]) / m;
        const eb = (rB[i] - tB[i]) / m;
        const e2 = kX * ex * ex + kY * ey * ey + kB * eb * eb;
        if (e2 > 1e-9) sum += e2 * Math.sqrt(e2);  // e2^(p/2) with p=3; pow() is far slower
    }
    return (sum / n) ** (1 / p);
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

// Compute Butteraugli-inspired score.
//
// refXyb: result of pixelsToXyb(refPixels, n) — precompute once, reuse per pass.
// testPixels: Uint8Array of RGBA bytes for the pass being compared.
//
// Returns a non-negative float; 0 = identical, ~0.5 = excellent, >1.5 = visible.
export function computeButteraugliVsFinal(refXyb, testPixels, width, height) {
    const n = width * height;
    if (!n || testPixels.length !== n * 4) return NaN;

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
