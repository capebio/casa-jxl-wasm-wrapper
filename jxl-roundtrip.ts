// End-to-end: ORF → wasm RGB8 → JXL encode → JXL decode → compare to
// embedded JPEG.  Confirms JXL preserves colour.

import init, { process_orf, downscale_rgb, rgb_to_rgba } from "./pkg/raw_converter_wasm.js";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import encodeJxl from "@jsquash/jxl/encode.js";
import decodeJxl from "@jsquash/jxl/decode.js";

const wasmBytes = readFileSync(
    new URL("./pkg/raw_converter_wasm_bg.wasm", import.meta.url),
);
await init({ module_or_path: wasmBytes });

const CMP_W = 1200;

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
    rgRatio: number;
    bgRatio: number;
    sat: number;
}

function stats(rgb: Uint8Array): Stats {
    const n = rgb.length / 3;
    let r = 0, g = 0, b = 0, lum = 0, sat = 0;
    for (let i = 0; i < n; i++) {
        const R = rgb[i*3], G = rgb[i*3+1], B = rgb[i*3+2];
        r += R; g += G; b += B;
        lum += 0.2126 * R + 0.7152 * G + 0.0722 * B;
        const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
        if (mx > 0) sat += (mx - mn) / mx;
    }
    return {
        rMean: r/n, gMean: g/n, bMean: b/n, lum: lum/n,
        rgRatio: (r/n) / Math.max(g/n, 1e-6),
        bgRatio: (b/n) / Math.max(g/n, 1e-6),
        sat: sat / n,
    };
}

const files = process.argv.slice(2);
for (const f of files) {
    const raw = new Uint8Array(readFileSync(f));

    // process
    const res = process_orf(raw, 0,0,0,0,0,0,0,0,0,0, NaN, NaN, 0, 0);
    const ours8 = res.take_rgb();
    const w = res.width, h = res.height;

    // Encode JXL from RGBA (lossless to isolate any colour drift from compression)
    const rgba = rgb_to_rgba(ours8);
    const rgbaBuf = rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength);
    const t0 = performance.now();
    const jxl = await encodeJxl(
        { data: new Uint8ClampedArray(rgbaBuf), width: w, height: h },
        { lossless: true, effort: 5 },
    );
    const encMs = performance.now() - t0;

    // Decode JXL back
    const dec = await decodeJxl(new Uint8Array(jxl));
    // dec is ImageData-like with rgba data
    const decRgba = new Uint8Array(dec.data.buffer, dec.data.byteOffset, dec.data.byteLength);

    // Strip alpha → RGB
    const decRgb = new Uint8Array(dec.width * dec.height * 3);
    for (let i = 0, j = 0; i < decRgb.length; i += 3, j += 4) {
        decRgb[i] = decRgba[j]; decRgb[i+1] = decRgba[j+1]; decRgb[i+2] = decRgba[j+2];
    }

    // Downscale both ours and dec to CMP_W
    const cmpH = Math.round((h * CMP_W) / w);
    const oursSmall = downscale_rgb(ours8, w, h, CMP_W, cmpH);
    const decSmall  = downscale_rgb(decRgb, dec.width, dec.height, CMP_W, cmpH);

    // Reference JPEG
    const jpeg = extractLargestJpeg(raw);
    if (!jpeg) { console.log(`${f}: no jpeg`); continue; }
    let refRgb: Uint8Array;
    try {
        const m = await sharp(jpeg).metadata();
        const refH = Math.round((m.height! * CMP_W) / m.width!);
        const r = await sharp(jpeg).resize(CMP_W, refH, { fit: 'fill' }).removeAlpha().raw().toBuffer();
        refRgb = new Uint8Array(r);
    } catch (e) {
        refRgb = new Uint8Array(0);
    }

    const name = f.split(/[\\/]/).pop()!;
    const fmt = (s: Stats) =>
        `R=${s.rMean.toFixed(0).padStart(3)} G=${s.gMean.toFixed(0).padStart(3)} B=${s.bMean.toFixed(0).padStart(3)} ` +
        `lum=${s.lum.toFixed(0).padStart(3)} sat=${s.sat.toFixed(2)} R/G=${s.rgRatio.toFixed(3)} B/G=${s.bgRatio.toFixed(3)}`;

    console.log(`\n=== ${name} ===  (jxl ${(jxl.byteLength/1024).toFixed(0)}KB, enc ${encMs.toFixed(0)}ms)`);
    if (refRgb.length > 0) console.log(`  jpeg ref : ${fmt(stats(refRgb))}`);
    console.log(`  ours rgb : ${fmt(stats(new Uint8Array(oursSmall)))}`);
    console.log(`  jxl->dec : ${fmt(stats(new Uint8Array(decSmall)))}`);
}
