// Compare our pipeline output vs the embedded JPEG inside the same .ORF.
// The embedded JPEG is the camera's own rendering — the "right" colour.
//
// Usage:  bun colour-cmp.ts <orf> [orf2 ...]

import init, { process_orf, downscale_rgb } from "./pkg/raw_converter_wasm.js";
import { readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";

const wasmBytes = readFileSync(
    new URL("./pkg/raw_converter_wasm_bg.wasm", import.meta.url),
);
await init({ module_or_path: wasmBytes });

const CMP_W = 1200;

// Largest embedded JPEG bitstream inside a TIFF/ORF container.
function extractLargestJpeg(bytes: Uint8Array): Uint8Array | null {
    const sois: number[] = [];
    for (let i = 0; i < bytes.length - 2; i++) {
        if (bytes[i] === 0xFF && bytes[i + 1] === 0xD8 && bytes[i + 2] === 0xFF) {
            sois.push(i); i += 2;
        }
    }
    let best: Uint8Array | null = null;
    for (let n = 0; n < sois.length; n++) {
        const start = sois[n];
        const end = n + 1 < sois.length ? sois[n + 1] : bytes.length;
        let eoi = -1;
        for (let j = end - 2; j >= start + 2; j--) {
            if (bytes[j] === 0xFF && bytes[j + 1] === 0xD9) { eoi = j; break; }
        }
        if (eoi !== -1) {
            const blob = bytes.slice(start, eoi + 2);
            if (!best || blob.length > best.length) best = blob;
        }
    }
    return best;
}

interface Stats {
    rMean: number; gMean: number; bMean: number;
    lum: number;
    rgRatio: number;   // R/G  – warmth
    bgRatio: number;   // B/G  – coolness
    sat: number;       // mean per-pixel saturation (max-min)/max
    contrastStd: number; // luminance std-dev
}

function stats(rgb: Uint8Array): Stats {
    const n = rgb.length / 3;
    let r = 0, g = 0, b = 0, lum = 0, sat = 0;
    const lums: number[] = new Array(n);
    for (let i = 0; i < n; i++) {
        const R = rgb[i*3], G = rgb[i*3+1], B = rgb[i*3+2];
        r += R; g += G; b += B;
        const L = 0.2126 * R + 0.7152 * G + 0.0722 * B;
        lum += L; lums[i] = L;
        const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
        if (mx > 0) sat += (mx - mn) / mx;
    }
    r /= n; g /= n; b /= n; lum /= n; sat /= n;
    let v = 0;
    for (let i = 0; i < n; i++) { const d = lums[i] - lum; v += d * d; }
    return {
        rMean: r, gMean: g, bMean: b, lum,
        rgRatio: r / Math.max(g, 1e-6),
        bgRatio: b / Math.max(g, 1e-6),
        sat,
        contrastStd: Math.sqrt(v / n),
    };
}

function pct(a: number, b: number): string {
    if (b < 1e-6) return '   n/a';
    const d = ((a / b) - 1) * 100;
    return (d >= 0 ? '+' : '') + d.toFixed(1) + '%';
}

const files = process.argv.slice(2);
if (files.length === 0) {
    console.error('usage: bun colour-cmp.ts <orf> [orf2 ...]');
    process.exit(1);
}

console.log(
    'file                     | source     |  R     G     B    lum  sat   ctr  |  R/G    B/G   | Δ vs JPEG'
);
console.log('-'.repeat(130));

for (const f of files) {
    try {
        const raw = new Uint8Array(readFileSync(f));

        // --- embedded JPEG → reference RGB at CMP_W ---
        const jpeg = extractLargestJpeg(raw);
        if (!jpeg) { console.log(`${f}: no embedded jpeg`); continue; }
        const jpegMeta = await sharp(jpeg).metadata();
        const refRgb = await sharp(jpeg)
            .resize(CMP_W, Math.round((jpegMeta.height! * CMP_W) / jpegMeta.width!), { fit: 'fill' })
            .removeAlpha().raw().toBuffer();

        // --- our pipeline → RGB at CMP_W ---
        const res = process_orf(raw, 0,0,0,0,0,0,0,0,0,0, NaN, NaN, 0, 0);
        const ours8 = res.take_rgb();
        const ourW = res.width, ourH = res.height;
        const refH = Math.round((jpegMeta.height! * CMP_W) / jpegMeta.width!);
        const oursSmall = downscale_rgb(ours8, ourW, ourH, CMP_W, refH);

        const sRef  = stats(new Uint8Array(refRgb));
        const sOurs = stats(new Uint8Array(oursSmall));

        const name = f.split(/[\\/]/).pop()!.padEnd(24);
        const fmtS = (s: Stats) =>
            `${s.rMean.toFixed(0).padStart(4)} ${s.gMean.toFixed(0).padStart(4)} ${s.bMean.toFixed(0).padStart(4)} ` +
            `${s.lum.toFixed(0).padStart(4)} ${s.sat.toFixed(2)} ${s.contrastStd.toFixed(0).padStart(4)} | ` +
            `${s.rgRatio.toFixed(3)} ${s.bgRatio.toFixed(3)}`;
        console.log(`${name} | embed jpeg | ${fmtS(sRef)} |  ref`);
        console.log(`${name} | ours rgb8  | ${fmtS(sOurs)} | sat ${pct(sOurs.sat, sRef.sat)}  ctr ${pct(sOurs.contrastStd, sRef.contrastStd)}  lum ${pct(sOurs.lum, sRef.lum)}`);

        // Save side-by-side pngs for visual confirmation
        const stem = f.replace(/.*[\\/]/, '').replace(/\.[^.]+$/, '');
        await sharp(refRgb, { raw: { width: CMP_W, height: refH, channels: 3 } })
            .png().toFile(`out_${stem}_ref.png`);
        await sharp(oursSmall, { raw: { width: CMP_W, height: refH, channels: 3 } })
            .png().toFile(`out_${stem}_ours.png`);
    } catch (e) {
        console.log(`${f}: error ${(e as Error).message}`);
    }
}
