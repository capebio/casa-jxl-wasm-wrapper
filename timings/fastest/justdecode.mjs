import { open, readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';

const ORF_PATH = String.raw`c:\995\2026-02-20 Gobabeb To Windhoek\P2200476 Pogonospermum cleomoides.ORF`;
const WASM_JS_URL = new URL('../../pkg/raw_converter_wasm.js', import.meta.url);
const WASM_BIN_URL = new URL('../../pkg/raw_converter_wasm_bg.wasm', import.meta.url);

// Olympus ORF preview JPEG is usually within the first few MB.
// 8 MB scan window covers typical layouts (thumb + full-res preview).
const SCAN_BYTES = 8 * 1024 * 1024;
const MIN_JPEG_BYTES = 1024;

/**
 * Scan a byte range for embedded JPEGs (SOI ... EOI).
 * Returns { smallest, largest } or { smallest: null, largest: null }.
 * "largest" is the full-resolution preview on Olympus ORFs.
 */
function scanEmbeddedJpegs(chunk, minBytes = MIN_JPEG_BYTES) {
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

    let smallest = null;
    let largest = null;

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

        const view = chunk.subarray(start, eoi);
        if (smallest === null || len < smallest.length) smallest = view;
        if (largest === null || len > largest.length) largest = view;
    }
    return { smallest, largest };
}

function stamp(t0, label) {
    const ms = performance.now() - t0;
    console.log(`[t+${ms.toFixed(2).padStart(8)} ms] ${label}`);
    return ms;
}

async function main() {
    const t0 = performance.now();
    console.log(`Reading ${ORF_PATH}`);

    // Open handle once; read scan window first to fire fast path ASAP.
    const fh = await open(ORF_PATH, 'r');
    let restPromise;
    let totalSize;
    try {
        const stat = await fh.stat();
        totalSize = stat.size;
        const scanLen = Math.min(SCAN_BYTES, totalSize);
        const scanBuf = Buffer.allocUnsafe(scanLen);
        await fh.read(scanBuf, 0, scanLen, 0);
        stamp(t0, `Read first ${scanLen} of ${totalSize} bytes`);

        // Fire scan immediately. Continue rest read in background, in parallel
        // with WASM init.
        const restLen = totalSize - scanLen;
        restPromise = restLen > 0
            ? (async () => {
                const rest = Buffer.allocUnsafe(restLen);
                await fh.read(rest, 0, restLen, scanLen);
                return rest;
            })()
            : Promise.resolve(Buffer.alloc(0));

        // --- FAST PATH: full-resolution embedded preview ---
        const { smallest, largest } = scanEmbeddedJpegs(scanBuf);
        stamp(t0, `Scanned for embedded JPEGs`);

        if (largest) {
            console.log(`  full-size preview JPEG: ${largest.length} bytes`);
            const t1 = performance.now();
            await writeFile('preview-full.jpg', largest);
            stamp(t0, `Wrote preview-full.jpg (+${(performance.now() - t1).toFixed(2)} ms write)`);
        } else {
            console.log('  no full-size preview JPEG found');
        }
        if (smallest && smallest !== largest) {
            console.log(`  thumb JPEG: ${smallest.length} bytes`);
            await writeFile('preview-thumb.jpg', smallest);
            stamp(t0, `Wrote preview-thumb.jpg`);
        }

        // --- Kick WASM init in parallel with rest-of-file read ---
        const wasmReady = (async () => {
            const [{ default: initRaw }, wasmBytes] = await Promise.all([
                import(WASM_JS_URL.href),
                readFile(WASM_BIN_URL),
            ]);
            await initRaw({ module_or_path: wasmBytes });
            return import(WASM_JS_URL.href); // resolved module with named exports
        })();

        const [rest, mod] = await Promise.all([restPromise, wasmReady]);
        stamp(t0, `WASM ready + rest of file in memory`);

        const { process_orf_with_flags, downscale_rgb } = mod;

        // Reassemble full buffer.
        const buf = rest.length === 0
            ? scanBuf
            : Buffer.concat([scanBuf, rest], totalSize);

        // --- SLOW PATH: WASM full decode ---
        const tWasm0 = performance.now();
        const result = process_orf_with_flags(
            buf,
            1, // OUT_FULL_RGB8
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            Number.NaN, Number.NaN, 0, 0,
        );
        const decodeMs = performance.now() - tWasm0;
        stamp(t0, `WASM full decode (${decodeMs.toFixed(2)} ms work)`);
        console.log(`  decompress: ${result.decompress_ms.toFixed(2)} ms`);
        console.log(`  demosaic:   ${result.demosaic_ms.toFixed(2)} ms`);
        console.log(`  tonemap:    ${result.tonemap_ms.toFixed(2)} ms`);
        console.log(`  orient:     ${result.orient_ms.toFixed(2)} ms`);

        const rgb = result.take_rgb();
        const w = result.width;
        const h = result.height;
        const thumbW = Math.round(w / 4);
        const thumbH = Math.round(h / 4);
        const thumbRgb = downscale_rgb(rgb, w, h, thumbW, thumbH);

        await sharp(Buffer.from(thumbRgb), {
            raw: { width: thumbW, height: thumbH, channels: 3 },
        }).png().toFile('wasm-thumbnail.png');
        stamp(t0, `Wrote wasm-thumbnail.png (${thumbW}x${thumbH})`);

        result.free();
    } finally {
        await fh.close();
    }

    stamp(t0, 'Done.');
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
