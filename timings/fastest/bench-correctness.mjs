// Correctness tests: pixel-diff fastjpeg vs sharp, and denom sweep.
// Same 7 files as bench-suite.mjs.

import { open } from 'node:fs/promises';
import sharp from 'sharp';
import { decode_scaled } from '../../crates/fast-jpeg/pkg/fast_jpeg.js';

const FILES = [
    String.raw`c:\995\2026-02-20 Gobabeb To Windhoek\P2200476 Pogonospermum cleomoides.ORF`,
    String.raw`c:\995\2026-02-20 Gobabeb To Windhoek\P2200564.ORF`,
    String.raw`c:\995\2026-02-20 Gobabeb To Windhoek\P2200699.ORF`,
    String.raw`c:\Foo\raw-converter\tests\PXL_20260501_093507165.RAW-02.ORIGINAL.dng`,
    String.raw`c:\Foo\raw-converter\tests\PXL_20260501_095020990.RAW-02.ORIGINAL.dng`,
    String.raw`c:\Foo\raw-converter\tests\_MG_1750.CR2`,
    String.raw`c:\Foo\raw-converter\tests\ADH 1248.CR2`,
];

const SCAN_BYTES = 8 * 1024 * 1024;
const MIN_JPEG_BYTES = 1024;

function scanAllJpegs(chunk, minBytes = MIN_JPEG_BYTES) {
    const sois = [];
    let i = 0;
    const last = chunk.length - 2;
    while (i < last) {
        if (chunk[i] === 0xFF && chunk[i + 1] === 0xD8 && chunk[i + 2] === 0xFF) {
            sois.push(i); i += 3;
        } else i++;
    }
    const found = [];
    for (let n = 0; n < sois.length; n++) {
        const start = sois[n];
        const end = (n + 1 < sois.length) ? sois[n + 1] : chunk.length;
        let eoi = -1;
        for (let j = end - 1; j > start + 1; j--) {
            if (chunk[j - 1] === 0xFF && chunk[j] === 0xD9) { eoi = j + 1; break; }
        }
        if (eoi === -1) continue;
        const len = eoi - start;
        if (len < minBytes) continue;
        found.push(chunk.subarray(start, eoi));
    }
    found.sort((a, b) => b.length - a.length);
    return found;
}

async function extractPreviewJpeg(path) {
    const fh = await open(path, 'r');
    let buf;
    try {
        const stat = await fh.stat();
        const scanLen = Math.min(SCAN_BYTES, stat.size);
        buf = Buffer.allocUnsafe(scanLen);
        await fh.read(buf, 0, scanLen, 0);
    } finally { await fh.close(); }
    const candidates = scanAllJpegs(buf);
    for (const c of candidates) {
        if (c.length <= 5 * 1024 * 1024) {
            try {
                await sharp(c).metadata();
                return Buffer.from(c);
            } catch { /* try next */ }
        }
    }
    throw new Error(`no parseable preview JPEG in ${path}`);
}

// ---------------- pixel diff ----------------

function diffStats(a, b) {
    if (a.length !== b.length) {
        throw new Error(`pixel buffers differ in length: ${a.length} vs ${b.length}`);
    }
    let sumAbs = 0;
    let maxAbs = 0;
    let nDiff = 0;
    const histR = [0, 0, 0, 0, 0]; // 0, 1-4, 5-16, 17-64, 65+
    for (let i = 0; i < a.length; i++) {
        const d = Math.abs(a[i] - b[i]);
        sumAbs += d;
        if (d > maxAbs) maxAbs = d;
        if (d !== 0) nDiff++;
        if (d === 0) histR[0]++;
        else if (d <= 4) histR[1]++;
        else if (d <= 16) histR[2]++;
        else if (d <= 64) histR[3]++;
        else histR[4]++;
    }
    return {
        mae: sumAbs / a.length,
        maxAbs,
        pctDiff: (nDiff / a.length) * 100,
        hist: histR,
    };
}

async function pixelDiffTest() {
    console.log('\n=== PIXEL DIFF: sharp vs fastjpeg (denom=2) ===\n');
    const header = `${'file'.padEnd(48)} ${'dims'.padEnd(12)} ${'MAE'.padStart(8)} ${'max'.padStart(5)} ${'%diff'.padStart(7)}  histogram (0 / 1-4 / 5-16 / 17-64 / 65+)`;
    console.log(header);
    console.log('-'.repeat(header.length));
    for (const file of FILES) {
        const short = file.split(/[\\/]/).pop();
        const jpeg = await extractPreviewJpeg(file);
        const meta = await sharp(jpeg).metadata();
        const targetW = Math.floor(meta.width / 2);

        const sharpOut = await sharp(jpeg)
            .resize({ width: targetW })
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });

        const fast = decode_scaled(jpeg, 2);

        if (sharpOut.info.width !== fast.width || sharpOut.info.height !== fast.height) {
            console.log(`${short.slice(0, 47).padEnd(48)} DIM MISMATCH sharp=${sharpOut.info.width}x${sharpOut.info.height} fast=${fast.width}x${fast.height}`);
            continue;
        }
        const stats = diffStats(sharpOut.data, fast.data);
        const total = stats.hist.reduce((a, b) => a + b, 0);
        const pct = (n) => ((n / total) * 100).toFixed(1) + '%';
        console.log(
            `${short.slice(0, 47).padEnd(48)} ${(`${fast.width}x${fast.height}`).padEnd(12)} ` +
            `${stats.mae.toFixed(3).padStart(8)} ${String(stats.maxAbs).padStart(5)} ${stats.pctDiff.toFixed(2).padStart(6)}% ` +
            ` ${pct(stats.hist[0])} / ${pct(stats.hist[1])} / ${pct(stats.hist[2])} / ${pct(stats.hist[3])} / ${pct(stats.hist[4])}`
        );
    }
}

// ---------------- denom sweep ----------------

async function denomSweepTest() {
    console.log('\n\n=== DENOM SWEEP: fastjpeg at scale 1, 2, 4, 8 ===\n');
    const header = `${'file'.padEnd(48)} ${'denom'.padStart(5)} ${'dims'.padEnd(13)} ${'bytes'.padStart(10)}`;
    console.log(header);
    console.log('-'.repeat(header.length));
    for (const file of FILES) {
        const short = file.split(/[\\/]/).pop();
        const jpeg = await extractPreviewJpeg(file);
        for (const denom of [1, 2, 4, 8]) {
            try {
                const r = decode_scaled(jpeg, denom);
                console.log(
                    `${short.slice(0, 47).padEnd(48)} ${String(denom).padStart(5)} ` +
                    `${(`${r.width}x${r.height}`).padEnd(13)} ${String(r.data.length).padStart(10)}`
                );
            } catch (e) {
                console.log(`${short.slice(0, 47).padEnd(48)} ${String(denom).padStart(5)} ERROR: ${e.message}`);
            }
        }
        console.log();
    }
}

async function main() {
    await pixelDiffTest();
    await denomSweepTest();
    process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
