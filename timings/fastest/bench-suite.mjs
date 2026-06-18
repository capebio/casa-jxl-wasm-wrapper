// Benchmark harness: 3 pipelines × 7 RAW files × 3 runs.
// Same file order each pipeline. Reports per-stage and total medians.
//
// Pipelines:
//   sharp     — libjpeg-turbo native decode (resize to half width) + JXL encode
//   nosharp   — JPEG→JXL transcode + JXL decode-downsample + JXL encode
//   fastjpeg  — fast-jpeg WASM decode (denom=2) + JXL encode
//
// All pipelines force JXL encoder tier 'simd' for apples-to-apples.
// JXL encode params identical: format=rgba8, effort=1, quality=75, progressive=false.

import { open } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { Worker as NodeWorker } from 'node:worker_threads';
import sharp from 'sharp';

// Install browser-Worker shim BEFORE importing jxl-wasm so detectTier sees Worker.
class BrowserLikeWorker {
    #worker;
    #onmessage = null;
    #onerror = null;
    constructor(url, options = {}) {
        const workerUrl = url instanceof URL ? url.href : String(url);
        this.#worker = new NodeWorker(new URL('../../jxl-worker-shim.mjs', import.meta.url), {
            workerData: { url: workerUrl, name: options.name ?? '' },
        });
        this.#worker.on('message', (data) => { this.#onmessage?.({ data }); });
        this.#worker.on('error', (error) => { this.#onerror?.(error); });
    }
    postMessage(message, transfer) { this.#worker.postMessage(message, transfer); }
    terminate() { return this.#worker.terminate(); }
    set onmessage(handler) { this.#onmessage = handler; }
    get onmessage() { return this.#onmessage; }
    set onerror(handler) { this.#onerror = handler; }
    get onerror() { return this.#onerror; }
}
if (typeof globalThis.Worker === 'undefined') {
    globalThis.Worker = BrowserLikeWorker;
    globalThis.navigator ??= {};
    globalThis.navigator.hardwareConcurrency ??= 8;
}

const {
    createEncoder,
    createDecoder,
    transcodeJpegToJxl,
    detectTier,
    setForcedTier,
} = await import('../../packages/jxl-wasm/dist/index.js');
const { decode_scaled } = await import('../../crates/fast-jpeg/pkg/fast_jpeg.js');

// MT tier (relaxed-simd-mt) deadlocks on Node.js main thread: Emscripten uses
// Atomics.waitAsync for pthread mailbox callbacks (G() in jxl-core.enc.relaxed-simd-mt.js),
// but those .then(H) microtasks can't fire while the main thread is blocked in a
// synchronous WASM call (transcodeJpegToJxl / decPush). Cross-run state accumulates
// → deadlock by run 3 of nosharp. inbetween-no-sharp.mjs carries the same guard.
setForcedTier('simd');

console.log(`Detected tier: ${detectTier?.() ?? '(unknown)'} (forced: simd)`);

const FILES = [
    String.raw`c:\995\2026-02-20 Gobabeb To Windhoek\P2200476 Pogonospermum cleomoides.ORF`,
    String.raw`c:\995\2026-02-20 Gobabeb To Windhoek\P2200564.ORF`,
    String.raw`c:\995\2026-02-20 Gobabeb To Windhoek\P2200699.ORF`,
    String.raw`c:\Foo\raw-converter\tests\PXL_20260501_093507165.RAW-02.ORIGINAL.dng`,
    String.raw`c:\Foo\raw-converter\tests\PXL_20260501_095020990.RAW-02.ORIGINAL.dng`,
    String.raw`c:\Foo\raw-converter\tests\_MG_1750.CR2`,
    String.raw`c:\Foo\raw-converter\tests\ADH 1248.CR2`,
];

const RUNS = 3;
const SCAN_BYTES = 8 * 1024 * 1024;
const MIN_JPEG_BYTES = 1024;

// Collect ALL embedded JPEGs (SOI..EOI) in scan window, sized descending.
function scanAllJpegs(chunk, minBytes = MIN_JPEG_BYTES) {
    const sois = [];
    let i = 0;
    const last = chunk.length - 2;
    while (i < last) {
        if (chunk[i] === 0xFF && chunk[i + 1] === 0xD8 && chunk[i + 2] === 0xFF) {
            sois.push(i);
            i += 3;
        } else {
            i++;
        }
    }
    const found = [];
    for (let n = 0; n < sois.length; n++) {
        const start = sois[n];
        const end = (n + 1 < sois.length) ? sois[n + 1] : chunk.length;
        let eoi = -1;
        for (let j = end - 1; j > start + 1; j--) {
            if (chunk[j - 1] === 0xFF && chunk[j] === 0xD9) {
                eoi = j + 1;
                break;
            }
        }
        if (eoi === -1) continue;
        const len = eoi - start;
        if (len < minBytes) continue;
        found.push(chunk.subarray(start, eoi));
    }
    found.sort((a, b) => b.length - a.length); // descending
    return found;
}

// Try each candidate (largest first, but skip the obvious full-res if
// it fails sharp metadata). Returns the first that sharp can parse.
async function extractPreviewJpeg(path) {
    const fh = await open(path, 'r');
    let buf;
    try {
        const stat = await fh.stat();
        const scanLen = Math.min(SCAN_BYTES, stat.size);
        buf = Buffer.allocUnsafe(scanLen);
        await fh.read(buf, 0, scanLen, 0);
    } finally {
        await fh.close();
    }
    const candidates = scanAllJpegs(buf);
    if (candidates.length === 0) throw new Error(`no embedded JPEG found in ${path}`);

    // Cap at 5MB to skip oversized full-res previews with non-standard markers
    // (Olympus full-res preview often has private 0xFF6C "thumbnail offset"
    // marker that libjpeg-turbo rejects). Prefer the largest that fits.
    for (const c of candidates) {
        if (c.length <= 5 * 1024 * 1024) {
            try {
                await sharp(c).metadata();
                return Buffer.from(c);
            } catch { /* try next */ }
        }
    }
    throw new Error(`no parseable preview JPEG found in ${path}`);
}

function exactBuffer(view) {
    if (view instanceof ArrayBuffer) return view;
    if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view.buffer;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

async function encodeJxl(rgba, width, height) {
    const t0 = performance.now();
    const encoder = createEncoder({
        format: 'rgba8',
        width,
        height,
        effort: 1,
        quality: 75,
        progressive: false,
    });
    const chunks = [];
    const chunkTask = (async () => {
        for await (const chunk of encoder.chunks()) {
            chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
        }
    })();
    await encoder.pushPixels(rgba);
    await encoder.finish();
    await chunkTask;
    await encoder.dispose();
    const ms = performance.now() - t0;
    const bytes = chunks.reduce((s, c) => s + c.length, 0);
    return { ms, bytes };
}

// ---------------- pipelines ----------------

async function runSharp(jpeg, sourceW) {
    const tDec = performance.now();
    const { data: rgba, info } = await sharp(jpeg)
        .resize({ width: Math.floor(sourceW / 2) })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    const decodeMs = performance.now() - tDec;
    const enc = await encodeJxl(rgba, info.width, info.height);
    return {
        decodeMs,
        encodeMs: enc.ms,
        totalMs: decodeMs + enc.ms,
        width: info.width,
        height: info.height,
        outBytes: enc.bytes,
    };
}

async function runNoSharp(jpeg) {
    const tDec = performance.now();
    const transcoded = await transcodeJpegToJxl(jpeg);
    const decoder = createDecoder({
        format: 'rgba8',
        downsample: 2,
        progressionTarget: 'final',
    });
    let rgba, finalW, finalH;
    const eventIterator = decoder.events();
    const pushTask = (async () => {
        await decoder.push(exactBuffer(transcoded));
        await decoder.close();
    })();
    for await (const ev of eventIterator) {
        if (ev.type === 'error') throw new Error(ev.message);
        if (ev.info) { finalW = ev.info.width; finalH = ev.info.height; }
        if (ev.type === 'final') rgba = ev.pixels;
    }
    await pushTask;
    await decoder.dispose();
    const decodeMs = performance.now() - tDec;
    const enc = await encodeJxl(rgba, finalW, finalH);
    return {
        decodeMs,
        encodeMs: enc.ms,
        totalMs: decodeMs + enc.ms,
        width: finalW,
        height: finalH,
        outBytes: enc.bytes,
    };
}

async function runFastJpeg(jpeg) {
    const tDec = performance.now();
    const result = decode_scaled(jpeg, 2);
    const rgba = result.data;
    const finalW = result.width;
    const finalH = result.height;
    const decodeMs = performance.now() - tDec;
    const enc = await encodeJxl(rgba, finalW, finalH);
    return {
        decodeMs,
        encodeMs: enc.ms,
        totalMs: decodeMs + enc.ms,
        width: finalW,
        height: finalH,
        outBytes: enc.bytes,
    };
}

// Optional: filter pipelines via env var BENCH_PIPELINES=sharp,fastjpeg
const ALL_PIPELINES = [
    { name: 'sharp', fn: runSharp },
    { name: 'nosharp', fn: runNoSharp },
    { name: 'fastjpeg', fn: runFastJpeg },
];
const want = (process.env.BENCH_PIPELINES ?? '').split(',').map(s => s.trim()).filter(Boolean);
const PIPELINES = want.length ? ALL_PIPELINES.filter(p => want.includes(p.name)) : ALL_PIPELINES;

function median(xs) {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
}

function pad(s, w) { return String(s).padEnd(w); }
function padNum(n, w) { return String(typeof n === 'number' ? n.toFixed(1) : n).padStart(w); }

async function main() {
    console.log(`Files: ${FILES.length}`);
    console.log(`Pipelines: ${PIPELINES.map(p => p.name).join(', ')}`);
    console.log(`Runs per (file, pipeline): ${RUNS}`);
    console.log(`Encoder: simd tier (forced), effort=1, q=75\n`);

    const results = {};

    for (const file of FILES) {
        const short = file.split(/[\\/]/).pop();
        console.log(`\n=== ${short} ===`);
        const jpeg = await extractPreviewJpeg(file);
        const meta = await sharp(jpeg).metadata();
        console.log(`Embedded JPEG: ${jpeg.length} bytes (${meta.width}x${meta.height})`);

        results[short] = {};
        for (const p of PIPELINES) {
            const runs = [];
            for (let r = 0; r < RUNS; r++) {
                const out = await p.fn(jpeg, meta.width);
                runs.push(out);
                console.log(
                    `  ${pad(p.name, 8)} run ${r + 1}: ` +
                    `decode=${padNum(out.decodeMs, 7)}ms ` +
                    `encode=${padNum(out.encodeMs, 7)}ms ` +
                    `total=${padNum(out.totalMs, 7)}ms ` +
                    `(${out.width}x${out.height}, ${out.outBytes}B)`
                );
            }
            results[short][p.name] = {
                decodeMs: median(runs.map(x => x.decodeMs)),
                encodeMs: median(runs.map(x => x.encodeMs)),
                totalMs: median(runs.map(x => x.totalMs)),
                width: runs[0].width,
                height: runs[0].height,
                outBytes: runs[0].outBytes,
            };
        }
    }

    console.log('\n\n=== MEDIAN SUMMARY (ms) ===\n');
    const header = `${pad('file', 48)} ${pad('pipeline', 10)} ${pad('decode', 8)} ${pad('encode', 8)} ${pad('total', 8)} ${pad('dims', 12)} ${pad('bytes', 8)}`;
    console.log(header);
    console.log('-'.repeat(header.length));
    for (const file of Object.keys(results)) {
        for (const p of PIPELINES) {
            const r = results[file][p.name];
            console.log(
                `${pad(file.slice(0, 47), 48)} ${pad(p.name, 10)} ` +
                `${padNum(r.decodeMs, 8)} ${padNum(r.encodeMs, 8)} ${padNum(r.totalMs, 8)} ` +
                `${pad(`${r.width}x${r.height}`, 12)} ${pad(r.outBytes, 8)}`
            );
        }
        console.log();
    }

    console.log('\n=== PER-PIPELINE TOTALS (sum of medians across files) ===\n');
    for (const p of PIPELINES) {
        const sumDec = Object.values(results).reduce((s, f) => s + f[p.name].decodeMs, 0);
        const sumEnc = Object.values(results).reduce((s, f) => s + f[p.name].encodeMs, 0);
        const sumTot = Object.values(results).reduce((s, f) => s + f[p.name].totalMs, 0);
        console.log(`  ${pad(p.name, 10)} decode=${padNum(sumDec, 8)}ms encode=${padNum(sumEnc, 8)}ms total=${padNum(sumTot, 8)}ms`);
    }

    process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
