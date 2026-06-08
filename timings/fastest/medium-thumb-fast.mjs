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
    console.log(`Reading medium thumbnail from ${ORF_PATH}...`);

    // The next-size-up preview in an ORF is usually within the first 2MB.
    // We can read just that portion to keep it incredibly fast.
    const CHUNK_SIZE = 2 * 1024 * 1024;
    
    const fh = await open(ORF_PATH, 'r');
    try {
        const buf = Buffer.allocUnsafe(CHUNK_SIZE);
        const { bytesRead } = await fh.read(buf, 0, CHUNK_SIZE, 0);
        stamp(t0, `Read first 2MB`);

        const chunk = buf.subarray(0, bytesRead);
        
        // Find all SOI markers (Start of Image)
        const sois = [];
        let i = 0;
        while (i < chunk.length - 2) {
            if (chunk[i] === 0xFF && chunk[i + 1] === 0xD8 && chunk[i + 2] === 0xFF) {
                sois.push(i);
                i += 3;
            } else {
                i++;
            }
        }

        // Find the matching EOI markers (End of Image) to extract JPEGs
        const jpegs = [];
        for (let n = 0; n < sois.length; n++) {
            const start = sois[n];
            const endLimit = (n + 1 < sois.length) ? sois[n + 1] : chunk.length;
            
            let eoi = -1;
            for (let j = endLimit - 1; j > start + 1; j--) {
                if (chunk[j - 1] === 0xFF && chunk[j] === 0xD9) {
                    eoi = j + 1;
                    break;
                }
            }
            if (eoi !== -1) {
                jpegs.push(chunk.subarray(start, eoi));
            }
        }

        // Sort the extracted JPEGs by size to confidently pick the "next size up"
        jpegs.sort((a, b) => a.length - b.length);

        if (jpegs.length >= 2) {
            const thumb = jpegs[1]; // The second smallest JPEG
            stamp(t0, `Located medium thumbnail (${thumb.length} bytes)`);
            await writeFile('medium-thumb-fast.jpg', thumb);
            stamp(t0, `Wrote medium-thumb-fast.jpg`);
        } else if (jpegs.length === 1) {
            console.log('Only one JPEG found in the first 2MB. Could not find a larger thumbnail.');
        } else {
            console.log('No JPEGs found in the first 2MB.');
        }
    } finally {
        await fh.close();
    }

    stamp(t0, 'Done.');
    process.exit(0);
}

main().catch(console.error);