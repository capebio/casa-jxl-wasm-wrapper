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
// pixels: Uint8Array RGBA (stride 4, alpha ignored). For batch reuse see createButteraugliComparer.
// Approx only; not bit-exact libjxl.
// Optional outX/outY/outB for zero-alloc in hot batch paths (comparer).
export function pixelsToXyb(pixels, n, outX, outY, outB) {
    const X = outX || new Float32Array(n);
    const Y = outY || new Float32Array(n);
    const B = outB || new Float32Array(n);
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
function scaleErr(mask, rX, rY, rB, tX, tY, tB, w, h, k = null) {
    const n = w * h;
    const p = 3.0;
    // Per-channel weights: opponent (X) highest, luminance (Y) mid, blue (B) lowest
    const kX = (k && k.kX) || 24, kY = (k && k.kY) || 12, kB = (k && k.kB) || 4;
    let sum = 0;
    for (let i = 0; i < n; i++) {
        const m = Math.max(0.15, mask[i] * 2.0 + 0.15);
        const ex = (rX[i] - tX[i]) / m;
        const ey = (rY[i] - tY[i]) / m;
        const eb = (rB[i] - tB[i]) / m;
        const e2 = kX * ex * ex + kY * ey * ey + kB * eb * eb;
        sum += e2 * Math.sqrt(e2 + 1e-12);  // branchless; e2^(p/2) p=3
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

// createButteraugliComparer: returns (testPixels)=>score fn with prealloc scratch for tX/tY/tB + dn buffers.
// Cuts alloc/GC for repeated cutoff evals vs same ref (profiling hot path). Keeps old API unchanged.
// opts: {weights?, k? {kX,kY,kB}, includeGradient?} for lens15/17/14 tuning.
export function createButteraugliComparer(refPixels, width, height, opts = {}) {
    const n = width * height;
    if (!n || refPixels.length !== n * 4) return () => NaN;  // consistent with compute* returning NaN on bad input (setup error path)
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
        pixelsToXyb(testPixels, n, tX, tY, tB);  // zero-alloc path, removes dup fill code

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

// Compute Butteraugli-inspired score.
//
// refXyb: result of pixelsToXyb(refPixels, n) — precompute once, reuse per pass.
// testPixels: Uint8Array of RGBA bytes for the pass being compared.
//
// Returns a non-negative float; 0 = identical, ~0.5 = excellent, >1.5 = visible.
// For batch/repeated + config (weights/k/gradient) use createButteraugliComparer (reuses bufs, lens15/14/17).
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

// 1-scale fast approx (full weight only). For coarse param sweeps / early reject in profiling.
// Still uses ref prep cache. For config use the comparer path.
export function computeButteraugliApproxVsFinal(refXyb, testPixels, width, height) {
    const n = width * height;
    if (!n || testPixels.length !== n * 4) return NaN;
    const ref = prepRef(refXyb, width, height);
    const L = ref.levels[0];
    let [tX, tY, tB] = pixelsToXyb(testPixels, n);
    return scaleErr(L.mask, L.X, L.Y, L.B, tX, tY, tB, width, height) * 4 / 7;
}

// Future (Lens17/12/16/14): Rust LookRenderer PerceptualConstancy (schrodinger geodesic + molchanov + losalamos)
// will allow illum-invariant sat/wb/exposure in progressive paints. Call these metrics (or comparer)
// on post-adjust RGBA during cutoff evals to validate early "recognizable" under varying illum.
// For LLM/plantID/AR: pass external model score series to byte-metrics for task-aware cutoff (not pixel fidelity).
// Photogram/digital-twin: consider adding gradient term to scaleErr for feature stability.

// ---------------------------------------------------------------------------
// WASM-backed path — uses PerceptualEngine from compiled raw_converter_wasm.
// Pointer-based: zero ArrayBuffer copy on the test side (direct view into WASM
// heap). Falls back to JS path if wasmModule has no PerceptualEngine.
// ---------------------------------------------------------------------------

// Create a WASM-backed comparer. Returns (testPixels) => score closure,
// same contract as createButteraugliComparer.
//
// wasmModule: instantiated wasm module (from raw_converter_wasm init()).
//   Must expose: PerceptualEngine class, memory export.
// refPixels:   Uint8Array RGBA, width*height*4 bytes.
// width/height: image dimensions in pixels.
//
// Returns null if PerceptualEngine is absent (older WASM build). Caller
// should fall back to createButteraugliComparer in that case.
export function createWasmEngine(wasmModule, refPixels, width, height) {
    if (!wasmModule || typeof wasmModule.PerceptualEngine !== 'function') {
        return null;
    }
    const n = width * height;
    if (!n || refPixels.length !== n * 4) return null;

    const engine = new wasmModule.PerceptualEngine(width, height);
    engine.set_reference(refPixels);

    // Cache a typed view into the WASM staging buffer for zero-copy test writes.
    // Re-create the view each call in case the WASM memory grows (buffer detaches).
    const ptr = engine.input_ptr();

    // Zero-copy path requires WASM memory export; fall back to copying compare().
    const hasMemory = wasmModule.memory instanceof WebAssembly.Memory;

    return function compareViaWasm(testPixels) {
        if (testPixels.length !== n * 4) return NaN;
        if (hasMemory) {
            // View recreated each call to handle potential WASM memory growth.
            const view = new Uint8Array(wasmModule.memory.buffer, ptr, n * 4);
            view.set(testPixels);
            return engine.compare_from_buf();
        }
        return engine.compare(testPixels);
    };
}

// Auto-select best available path: WASM if PerceptualEngine present, else JS.
// Drop-in replacement for createButteraugliComparer in performance-sensitive paths.
export function createBestEngine(wasmModule, refPixels, width, height) {
    const wasm = createWasmEngine(wasmModule, refPixels, width, height);
    if (wasm) return wasm;
    return createButteraugliComparer(refPixels, width, height);
}

