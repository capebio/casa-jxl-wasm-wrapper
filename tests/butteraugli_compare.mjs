// tests/butteraugli_compare.mjs
// Benchmark harness: JS butteraugli path vs WASM PerceptualEngine.
//
// Usage:
//   node tests/butteraugli_compare.mjs
//
// Output: CSV  image,mode,iter,ms,score,delta
// delta = (wasm_score - js_baseline), empty for JS rows.

import { createButteraugliComparer, createWasmEngine } from '../web/jxl-butteraugli.js';

const ITERATIONS = 10;

// ---- Synthetic image generation ----

function makeSyntheticRgba(w, h, seed) {
    const data = new Uint8Array(w * h * 4);
    let x = seed >>> 0;
    for (let i = 0; i < data.length; i++) {
        x = Math.imul(x, 1664525) + 1013904223 >>> 0;
        data[i] = (i % 4 === 3) ? 255 : (x >>> 24);
    }
    return data;
}

// ---- WASM loader ----

async function loadWasm() {
    try {
        const { readFile } = await import('node:fs/promises');
        const { pathToFileURL } = await import('node:url');
        const pkgDir = new URL('../web/pkg/', import.meta.url);
        const wasmBytes = await readFile(new URL('raw_converter_wasm_bg.wasm', pkgDir));
        const wasmModule = await WebAssembly.compile(wasmBytes);
        // Dynamic import needs file:// URL on Windows (bare relative path fails for ESM)
        const pkgJsUrl = pathToFileURL(
            new URL('../web/pkg/raw_converter_wasm.js', import.meta.url).pathname.replace(/^\//, '')
        ).href;
        const mod = await import(pkgJsUrl);
        await mod.default({ module_or_path: wasmModule });
        if (typeof mod.PerceptualEngine === 'function') return mod;
        console.warn('# WASM loaded but PerceptualEngine missing — rebuild needed');
        return null;
    } catch (e) {
        console.warn('# WASM unavailable — JS path only:', e.message);
        return null;
    }
}

// ---- Comparison runner ----

async function runCase(label, w, h, refSeed, testSeed, wasmModule) {
    const ref = makeSyntheticRgba(w, h, refSeed);
    const test = makeSyntheticRgba(w, h, testSeed);
    const rows = [];

    // JS path (10 warm iterations)
    const jsComparer = createButteraugliComparer(ref, w, h);
    let jsLastScore = NaN;
    for (let i = 0; i < ITERATIONS; i++) {
        const t0 = performance.now();
        const score = jsComparer(test);
        const ms = performance.now() - t0;
        jsLastScore = score;
        rows.push(`${label},js,${i},${ms.toFixed(3)},${score.toFixed(6)},`);
    }

    // WASM path (if available)
    if (wasmModule) {
        const wasmFn = createWasmEngine(wasmModule, ref, w, h);
        if (wasmFn) {
            for (let i = 0; i < ITERATIONS; i++) {
                const t0 = performance.now();
                const score = wasmFn(test);
                const ms = performance.now() - t0;
                const delta = (score - jsLastScore).toFixed(6);
                rows.push(`${label},wasm,${i},${ms.toFixed(3)},${score.toFixed(6)},${delta}`);
            }
        } else {
            rows.push(`${label},wasm,0,N/A,N/A,# createWasmEngine returned null`);
        }
    }

    return rows;
}

// ---- Main ----

async function main() {
    console.log('image,mode,iter,ms,score,delta');

    const wasmModule = await loadWasm();

    const cases = [
        { label: 'synthetic-64',   w: 64,   h: 64,   ref: 1, tst: 2 },
        { label: 'synthetic-256',  w: 256,  h: 256,  ref: 3, tst: 4 },
        { label: 'synthetic-512',  w: 512,  h: 512,  ref: 5, tst: 6 },
        { label: 'synthetic-1024', w: 1024, h: 1024, ref: 7, tst: 8 },
    ];

    for (const c of cases) {
        const rows = await runCase(c.label, c.w, c.h, c.ref, c.tst, wasmModule);
        for (const r of rows) console.log(r);
    }

    // Score stability check: all 10 JS iterations for each image must be identical.
    console.error('# Stability check: verifying JS scores are deterministic across iterations...');
    for (const c of cases) {
        const ref = makeSyntheticRgba(c.w, c.h, c.ref);
        const test = makeSyntheticRgba(c.w, c.h, c.tst);
        const jsComparer = createButteraugliComparer(ref, c.w, c.h);
        const scores = Array.from({ length: 3 }, () => jsComparer(test));
        const allEqual = scores.every(s => s === scores[0]);
        if (!allEqual) {
            console.error(`# FAIL: ${c.label} JS scores differ: ${scores.join(', ')}`);
            process.exitCode = 1;
        } else {
            console.error(`# OK: ${c.label} JS score stable at ${scores[0].toFixed(6)}`);
        }
    }
}

main().catch(e => { console.error(e); process.exit(1); });
