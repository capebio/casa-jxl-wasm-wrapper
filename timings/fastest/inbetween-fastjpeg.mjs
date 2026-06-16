import { open, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createEncoder, setForcedTier } from '../../packages/jxl-wasm/dist/index.js';

// Node has no Worker for Emscripten pthread pool; MT tier fails. Use simd (same as no-sharp baseline).
setForcedTier('simd');
import { decode_scaled } from '../../crates/fast-jpeg/pkg/fast_jpeg.js';

const ORF_PATH = String.raw`c:\995\2026-02-20 Gobabeb To Windhoek\P2200476 Pogonospermum cleomoides.ORF`;

async function main() {
    console.log('Starting Fast-JPEG Pipeline (WASM decode + JXL encode)...');
    const tTotal0 = performance.now();

    // 1. EXTRACTION
    const fh = await open(ORF_PATH, 'r');
    let mediumJpeg;
    try {
        const buf = Buffer.allocUnsafe(2 * 1024 * 1024);
        await fh.read(buf, 0, buf.length, 0);
        const SOI = Buffer.from([0xFF, 0xD8, 0xFF]);
        const start = buf.indexOf(SOI, 0);
        const next = buf.indexOf(SOI, start + 3);
        const EOI = Buffer.from([0xFF, 0xD9]);
        const end = buf.indexOf(EOI, next);
        mediumJpeg = buf.subarray(next, end + 2);
    } finally {
        await fh.close();
    }
    console.log(`Extracted JPEG: ${mediumJpeg.length} bytes`);

    // 2. SINGLE-PASS JPEG → RGBA (DCT-domain downscale in WASM)
    const tDec = performance.now();
    const result = decode_scaled(mediumJpeg, 2);
    const rgba = result.data;
    const finalW = result.width;
    const finalH = result.height;
    console.log(`decode_scaled: ${(performance.now() - tDec).toFixed(2)} ms (${finalW}x${finalH})`);

    // 3. ENCODE TO JXL
    console.log('Step 3: Encoding Final JXL...');
    const t1 = performance.now();
    const encoder = createEncoder({
        format: 'rgba8',
        width: finalW,
        height: finalH,
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
    console.log(`  -> Encoded in ${(performance.now() - t1).toFixed(2)} ms`);

    const jxlBytes = Buffer.concat(chunks.map(c => Buffer.from(c)));
    await writeFile('inbetween-fastjpeg.jxl', jxlBytes);

    console.log(`\nResult: inbetween-fastjpeg.jxl (${jxlBytes.length} bytes)`);
    console.log(`Total Time: ${(performance.now() - tTotal0).toFixed(2)} ms`);
    process.exit(0);
}

main().catch(console.error);