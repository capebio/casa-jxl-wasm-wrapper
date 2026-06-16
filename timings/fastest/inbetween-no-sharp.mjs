import { open, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createEncoder, createDecoder, setForcedTier, transcodeJpegToJxl } from '../../packages/jxl-wasm/dist/index.js';

const ORF_PATH = String.raw`c:\995\2026-02-20 Gobabeb To Windhoek\P2200476 Pogonospermum cleomoides.ORF`;

function exactBuffer(view) {
    if (view instanceof ArrayBuffer) return view;
    if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view.buffer;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

async function main() {
    // Use SIMD single-thread for this specific double-pass script for stability
    setForcedTier('simd');

    console.log("Starting No-Sharp Pipeline (Pure WASM)...");
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

    // 2. TRANSCODE + DOWNSAMPLE (Pure WASM)
    console.log("Step 1: Transcoding JPEG to JXL...");
    const t0 = performance.now();
    const transcoded = await transcodeJpegToJxl(mediumJpeg);
    
    console.log("Step 2: Decoding & Downsampling...");
    const decoder = createDecoder({
        format: 'rgba8',
        downsample: 2, 
        progressionTarget: 'final'
    });
    
    let rgba, finalW, finalH;

    const eventIterator = decoder.events();
    const pushTask = (async () => {
        await decoder.push(exactBuffer(transcoded));
        await decoder.close();
    })();

    for await (const ev of eventIterator) {
        if (ev.type === 'error') throw new Error(ev.message);
        if (ev.info) {
            // Keep track of dimensions from any event that has them
            finalW = ev.info.width;
            finalH = ev.info.height;
        }
        if (ev.type === 'final') {
            rgba = ev.pixels;
        }
    }
    await pushTask;
    await decoder.dispose();

    if (!rgba || !finalW) {
        throw new Error("Failed to decode pixels or capture dimensions.");
    }
    console.log(`  -> Ready at ${finalW}x${finalH} in ${(performance.now() - t0).toFixed(2)} ms`);

    // 3. ENCODE TO JXL
    console.log("Step 3: Encoding Final JXL...");
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
    await writeFile('inbetween-no-sharp.jxl', jxlBytes);
    
    console.log(`\nResult: inbetween-no-sharp.jxl (${jxlBytes.length} bytes)`);
    console.log(`Total Time: ${(performance.now() - tTotal0).toFixed(2)} ms`);
    process.exit(0);
}

main().catch(console.error);