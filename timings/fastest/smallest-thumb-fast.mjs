import { open, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const ORF_PATH = String.raw`c:\995\2026-02-20 Gobabeb To Windhoek\P2200476 Pogonospermum cleomoides.ORF`;

function stamp(t0, label) {
    const ms = performance.now() - t0;
    console.log(`[t+${ms.toFixed(2).padStart(8)} ms] ${label}`);
    return ms;
}

async function main() {
    const t0 = performance.now();
    console.log(`Reading smallest thumbnail from ${ORF_PATH}...`);

    // The absolute smallest thumbnail in an ORF is usually within the first 128KB.
    // By only reading this tiny chunk, we can extract it in ~2 milliseconds.
    const CHUNK_SIZE = 128 * 1024;
    
    const fh = await open(ORF_PATH, 'r');
    try {
        const buf = Buffer.allocUnsafe(CHUNK_SIZE);
        await fh.read(buf, 0, CHUNK_SIZE, 0);
        stamp(t0, `Read first 128KB`);

        // Find the first JPEG (SOI = FF D8 FF)
        const start = buf.indexOf(Buffer.from([0xFF, 0xD8, 0xFF]));
        if (start !== -1) {
            // Find the end (EOI = FF D9)
            const end = buf.indexOf(Buffer.from([0xFF, 0xD9]), start);
            if (end !== -1) {
                const thumb = buf.subarray(start, end + 2);
                stamp(t0, `Located thumbnail (${thumb.length} bytes)`);
                
                await writeFile('absolute-smallest-thumb.jpg', thumb);
                stamp(t0, `Wrote absolute-smallest-thumb.jpg`);
            } else {
                console.log('Thumbnail end not found in the first 128KB.');
            }
        } else {
            console.log('No thumbnail found in the first 128KB.');
        }
    } finally {
        await fh.close();
    }

    stamp(t0, 'Done.');
    process.exit(0);
}

main().catch(console.error);