// frame-stats telemetry flip-flop: JS baseline vs wasm {scalar, autovec-fast, hand-SIMD, copy}.
//
// Build first (from repo root), wasm128 nodejs target:
//   $env:RUSTFLAGS="-C target-feature=+simd128"
//   wasm-pack build --target nodejs --out-dir pkg-bench --release
//   node tools/frame-stats-flipflop.mjs
//
// TRUE alternation each iter (time-varying background load cancels in the ratio) + MIN
// (least-contended, robust) + median. Correctness is pinned BEFORE timing: every variant's
// stats must match the JS baseline; the exact-hash variants must also match frameHashInt.
import { performance } from 'node:perf_hooks';

const wasmMod = await import('../pkg-bench/raw_converter_wasm.js');
const wasm = wasmMod.default ?? wasmMod;
const { fstats_prepare, fstats_scalar, fstats_fast, fstats_simd, fstats_simd_exact, fstats_copy } = wasm;

// --- JS baseline: the exact shipped analyzeProgressiveFrame kernel ---
function jsBaseline(data, w, h) {
    const px = w * h, exp = px * 4;
    let aMin = 255, aMax = 0, aZero = 0, rgbNZ = 0, lSum = 0, lSq = 0, hash = 0x811c9dc5;
    for (let i = 0; i < exp; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
        hash ^= r; hash = Math.imul(hash, 0x01000193) >>> 0;
        hash ^= g; hash = Math.imul(hash, 0x01000193) >>> 0;
        hash ^= b; hash = Math.imul(hash, 0x01000193) >>> 0;
        hash ^= a; hash = Math.imul(hash, 0x01000193) >>> 0;
        rgbNZ += (r !== 0) + (g !== 0) + (b !== 0);
        if (a < aMin) aMin = a; if (a > aMax) aMax = a; if (a === 0) aZero++;
        const L = 54 * r + 183 * g + 18 * b; lSum += L; lSq += L * L;
    }
    const mean = px ? lSum / px : 0;
    return {
        alphaMin: aMin, alphaMax: aMax, alphaZeroPct: px ? (aZero / px) * 100 : 0,
        rgbNonzeroCount: rgbNZ, lumaVariance: px ? Math.max(0, lSq / px - mean * mean) / 65536 : 0,
        meanLuma: mean / 256, frameHashInt: hash >>> 0, pixelCount: px,
    };
}

// JS fast (de-serialized 2-lane word-hash) — JS-side migration candidate, for reference.
function jsFast(data, w, h) {
    const px = w * h; const u32 = new Uint32Array(data.buffer, data.byteOffset, px);
    let aMin = 255, aMax = 0, aZero = 0, rgbNZ = 0, lSum = 0, h0 = 0x811c9dc5, h1 = 0x9e3779b9 >>> 0;
    let lSq = 0;
    for (let p = 0; p < px; p += 2) {
        const w0 = u32[p], w1 = (p + 1 < px) ? u32[p + 1] : 0;
        h0 = Math.imul(h0 ^ w0, 0x01000193) >>> 0;
        h1 = Math.imul(h1 ^ w1, 0x01000193) >>> 0;
        for (const wd of (p + 1 < px ? [w0, w1] : [w0])) {
            const r = wd & 0xff, g = (wd >>> 8) & 0xff, b = (wd >>> 16) & 0xff, a = wd >>> 24;
            rgbNZ += (r !== 0) + (g !== 0) + (b !== 0);
            if (a < aMin) aMin = a; if (a > aMax) aMax = a; if (a === 0) aZero++;
            const L = 54 * r + 183 * g + 18 * b; lSum += L; lSq += L * L;
        }
    }
    const mean = px ? lSum / px : 0;
    return {
        alphaMin: aMin, alphaMax: aMax, alphaZeroPct: px ? (aZero / px) * 100 : 0,
        rgbNonzeroCount: rgbNZ, lumaVariance: px ? Math.max(0, lSq / px - mean * mean) / 65536 : 0,
        meanLuma: mean / 256, frameHashInt: (Math.imul(h0 ^ h1, 0x01000193) >>> 0), pixelCount: px,
    };
}

function makeBuf(w, h) {
    const data = new Uint8Array(w * h * 4);
    let s = 12345;
    for (let k = 0; k < data.length; k++) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; data[k] = s & 0xff; }
    return data;
}

const APPROX = 1e-6;
function statsEqual(a, b) {
    const keys = ['alphaMin', 'alphaMax', 'alphaZeroPct', 'rgbNonzeroCount', 'lumaVariance', 'pixelCount'];
    for (const k of keys) {
        if (Math.abs(Number(a[k]) - Number(b[k])) > Math.abs(Number(b[k])) * APPROX + APPROX) {
            return `STATS MISMATCH ${k}: ${a[k]} vs ${b[k]}`;
        }
    }
    return null;
}

const min = a => Math.min(...a);
const median = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const t1 = fn => { const s = performance.now(); const v = fn(); return [performance.now() - s, v]; };

const sizes = [[1920, 1280, '2.46MP full'], [1024, 1024, '1.05MP cap']];

for (const [W, H, label] of sizes) {
    const data = makeBuf(W, H);
    const buf = data; // Uint8Array for the copy path
    fstats_prepare(W, H);

    // --- correctness pins (before timing) ---
    const base = jsBaseline(data, W, H);
    const wScalar = fstats_scalar();
    const wCopy = fstats_copy(buf, W, H);
    const wFast = fstats_fast();
    const wSimd = fstats_simd();
    const wSimdExact = fstats_simd_exact();
    const jFast = jsFast(data, W, H);

    const problems = [];
    for (const [nm, r, exactHash] of [
        ['wasm-scalar', wScalar, true], ['wasm-copy', wCopy, true],
        ['wasm-simd-exact', wSimdExact, true],
        ['wasm-fast', wFast, false], ['wasm-simd', wSimd, false], ['js-fast', jFast, false],
    ]) {
        const e = statsEqual(r, base); if (e) problems.push(`${nm}: ${e}`);
        if (exactHash && (r.frameHashInt >>> 0) !== (base.frameHashInt >>> 0))
            problems.push(`${nm}: HASH ${r.frameHashInt} != baseline ${base.frameHashInt}`);
    }
    // fast and hand-simd share the same word-hash definition -> must agree
    if ((wFast.frameHashInt >>> 0) !== (wSimd.frameHashInt >>> 0))
        problems.push(`wasm-fast/simd hash disagree: ${wFast.frameHashInt} vs ${wSimd.frameHashInt}`);

    console.log(`\n=== ${label} (${W}x${H}) ===`);
    if (problems.length) { console.log('CORRECTNESS FAIL:\n  ' + problems.join('\n  ')); process.exitCode = 1; }
    else console.log('correctness: OK (all stats match baseline; exact-hash variants match FNV)');

    const variants = [
        ['js-baseline (byte FNV) ', () => jsBaseline(data, W, H)],
        ['js-fast (word-hash)    ', () => jsFast(data, W, H)],
        ['wasm-scalar (byte FNV) ', fstats_scalar],
        ['wasm-simd-exact (FNV)  ', fstats_simd_exact],
        ['wasm-fast (autovec ILP)', fstats_fast],
        ['wasm-simd (hand v128)  ', fstats_simd],
        ['wasm-copy (+bindgen cp)', () => fstats_copy(buf, W, H)],
    ];
    // warm
    let sink = 0;
    for (let i = 0; i < 10; i++) for (const [, fn] of variants) { const v = fn(); sink ^= (typeof v === 'object' ? v.rgbNonzeroCount : v) | 0; }
    const ITERS = 40;
    const times = variants.map(() => []);
    for (let i = 0; i < ITERS; i++)
        for (let v = 0; v < variants.length; v++) { const [t, val] = t1(variants[v][1]); times[v].push(t); sink ^= (val.rgbNonzeroCount | 0); }
    if (sink === -1) console.log('');

    const baseMin = min(times[0]);
    console.log('variant                   min ms   median ms   vs js-baseline');
    for (let v = 0; v < variants.length; v++) {
        const mn = min(times[v]), md = median(times[v]);
        console.log(`${variants[v][0]}  ${mn.toFixed(2).padStart(6)}   ${md.toFixed(2).padStart(7)}     ${(baseMin / mn).toFixed(2)}x`);
    }
}
