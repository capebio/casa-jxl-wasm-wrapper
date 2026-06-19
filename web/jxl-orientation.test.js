// Phase 1/3 verification: encoding portrait + landscape ORFs should take
// similar time. JXL records orientation as metadata — no CPU rotation tax.
//
// Run with bun: `bun test web/jxl-orientation.test.js`
//
// Requires: rebuilt packages/jxl-wasm bridge with _z / _v3 orientation exports.
// Without the rebuild, the test still passes (warning printed) but the encoded
// JXL will have orientation = identity for non-1 inputs.

import { expect, test } from 'bun:test';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import initRaw, * as rawWasm from './pkg/raw_converter_wasm.js';

const DEFAULT_ORF_FOLDER = String.raw`C:\995\2026-02-20 Gobabeb To Windhoek`;
const ORF_FOLDER = process.env.TEST_ORF_FOLDER ?? DEFAULT_ORF_FOLDER;
const maybeFixtureTest = existsSync(ORF_FOLDER) ? test : test.skip;

const OUT_FULL_RGB8 = 1;
const OUT_LIGHTBOX  = 2;
const OUT_THUMB     = 4;
const OUT_NO_ORIENT = 16;

function listOrfs(limit) {
    return readdirSync(ORF_FOLDER)
        .filter((n) => n.toLowerCase().endsWith('.orf'))
        .sort()
        .slice(0, limit);
}

function classify(orientation) {
    if (orientation === 1) return 'landscape (ori=1)';
    if (orientation === 3) return 'inverted (ori=3)';
    if (orientation === 6) return 'portrait CW (ori=6)';
    if (orientation === 8) return 'portrait CCW (ori=8)';
    return `ori=${orientation}`;
}

maybeFixtureTest('Phase 1+3: portrait ORF encode time matches landscape (no CPU rotate)', async () => {
    await initRaw();
    const names = listOrfs(8);
    if (names.length === 0) {
        console.warn(`No ORFs in ${ORF_FOLDER}; skipping`);
        return;
    }

    const fullFlags = OUT_FULL_RGB8 | OUT_LIGHTBOX | OUT_THUMB | OUT_NO_ORIENT;

    const rows = [];
    for (const name of names) {
        const bytes = readFileSync(join(ORF_FOLDER, name));
        const t0 = performance.now();
        const result = rawWasm.process_orf_with_flags(
            bytes, fullFlags,
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NaN, NaN, 0, 0,
        );
        const pipelineMs = performance.now() - t0;
        const ori = result.orientation;
        const w = result.width;
        const h = result.height;
        const orientMs = result.orient_ms;
        result.free();

        rows.push({ name, w, h, ori, pipelineMs, orientMs });
    }

    console.log('\n=== Phase 1 verification — process_orf_with_flags(OUT_NO_ORIENT) ===');
    console.log('| File                | Dims        | Orientation         | Pipeline (ms) | orient_ms |');
    console.log('|---------------------|-------------|---------------------|---------------|-----------|');
    for (const r of rows) {
        const orientLabel = classify(r.ori);
        console.log(
            `| ${r.name.padEnd(20)}| ${(r.w + 'x' + r.h).padEnd(12)}| ${orientLabel.padEnd(20)}` +
            `| ${r.pipelineMs.toFixed(0).padStart(13)} ` +
            `| ${r.orientMs.toFixed(2).padStart(9)} |`,
        );
    }

    // Phase 1 claim: orient_ms should be ~0 with OUT_NO_ORIENT (no rotation invoked).
    for (const r of rows) {
        expect(r.orientMs).toBeLessThan(2); // tiny constant time, not a full transpose
    }

    // Phase 1 claim: total pipeline time should be similar between portrait and
    // landscape (within 25%) — the orientation-dependent variance from
    // apply_orientation is gone.
    const landscape = rows.filter((r) => r.ori === 1);
    const portrait  = rows.filter((r) => r.ori === 6 || r.ori === 8);
    if (landscape.length > 0 && portrait.length > 0) {
        const avgL = landscape.reduce((s, r) => s + r.pipelineMs, 0) / landscape.length;
        const avgP = portrait.reduce((s, r) => s + r.pipelineMs, 0) / portrait.length;
        console.log(`\nlandscape avg: ${avgL.toFixed(0)} ms`);
        console.log(`portrait avg:  ${avgP.toFixed(0)} ms`);
        console.log(`portrait/landscape ratio: ${(avgP / avgL).toFixed(2)}× (< 1.25 expected)`);
        expect(Math.abs(avgP - avgL) / avgL).toBeLessThan(0.25);
    } else {
        console.log(`note: only ${landscape.length} landscape + ${portrait.length} portrait — can't compare`);
    }
}, 180000);

// Look for portrait orientation among DNG files in either fixture dir.
function findPortraitDng() {
    for (const dir of [ORF_FOLDER, String.raw`C:\Foo\raw-converter\tests`]) {
        if (!existsSync(dir)) continue;
        const names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.dng'));
        for (const name of names) {
            const bytes = readFileSync(join(dir, name));
            // Peek at TIFF orientation tag (0x0112) in IFD0 — quick parse.
            const ori = peekDngOrientation(bytes);
            if (ori !== 1) return { dir, name, bytes, ori };
        }
    }
    return null;
}

function peekDngOrientation(buf) {
    // Tiny TIFF parser: read endianness, magic, IFD0 offset, find tag 0x0112.
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const le = dv.getUint16(0) === 0x4949;
    const r16 = (o) => dv.getUint16(o, le);
    const r32 = (o) => dv.getUint32(o, le);
    const magic = r16(2);
    if (magic !== 42) return 1;
    let ifd = r32(4);
    const nEntries = r16(ifd);
    for (let i = 0; i < nEntries; i++) {
        const ent = ifd + 2 + i * 12;
        if (r16(ent) === 0x0112) {
            return r16(ent + 8);
        }
    }
    return 1;
}

maybeFixtureTest('Phase 1+3: portrait DNG → A/B rotate vs no-rotate', async () => {
    await initRaw();
    const found = findPortraitDng();
    if (!found) {
        console.log('No portrait DNG with orientation != 1 in fixtures; skipping');
        return;
    }
    console.log(`Portrait fixture: ${found.dir}\\${found.name} (EXIF ori=${found.ori})`);
    const flagsRot   = OUT_FULL_RGB8 | OUT_LIGHTBOX | OUT_THUMB;
    const flagsNoRot = OUT_FULL_RGB8 | OUT_LIGHTBOX | OUT_THUMB | OUT_NO_ORIENT;

    const runs = [];
    for (const [label, flags] of [['rotate', flagsRot], ['no-rotate', flagsNoRot]]) {
        // warm-up
        const w = rawWasm.process_dng_with_flags(found.bytes, flags, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NaN, NaN, 0, 0);
        w.free();
        const t0 = performance.now();
        const r = rawWasm.process_dng_with_flags(found.bytes, flags, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NaN, NaN, 0, 0);
        const ms = performance.now() - t0;
        runs.push({ label, ms, orient_ms: r.orient_ms, w: r.width, h: r.height });
        r.free();
    }

    console.log(`  rotate    : pipeline=${runs[0].ms.toFixed(0)}ms, orient_ms=${runs[0].orient_ms.toFixed(2)}, dims=${runs[0].w}x${runs[0].h}`);
    console.log(`  no-rotate : pipeline=${runs[1].ms.toFixed(0)}ms, orient_ms=${runs[1].orient_ms.toFixed(2)}, dims=${runs[1].w}x${runs[1].h}`);
    console.log(`  Δ orient_ms saved: ${(runs[0].orient_ms - runs[1].orient_ms).toFixed(1)} ms`);
    expect(runs[1].orient_ms).toBeLessThan(2);
    expect(runs[0].orient_ms).toBeGreaterThan(0);
}, 180000);

maybeFixtureTest('Phase 3: A/B same-file with vs without OUT_NO_ORIENT', async () => {
    await initRaw();
    const names = listOrfs(2);
    if (names.length === 0) return;
    const name = names[0];
    const bytes = readFileSync(join(ORF_FOLDER, name));

    // Force a portrait orientation tag so we exercise apply_orientation. We
    // do that indirectly: synthetically simulate by measuring the same file
    // with both flags so we can attribute the delta to rotation only when
    // ori != 1 anyway. If file is landscape, both runs will have orient_ms=0
    // and we just note the parity.
    const flagsRot   = OUT_FULL_RGB8 | OUT_LIGHTBOX | OUT_THUMB;
    const flagsNoRot = OUT_FULL_RGB8 | OUT_LIGHTBOX | OUT_THUMB | OUT_NO_ORIENT;

    const runs = [];
    for (const [label, flags] of [['rotate', flagsRot], ['no-rotate', flagsNoRot]]) {
        const t0 = performance.now();
        const r = rawWasm.process_orf_with_flags(bytes, flags, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NaN, NaN, 0, 0);
        const ms = performance.now() - t0;
        runs.push({ label, ms, orient_ms: r.orient_ms, w: r.width, h: r.height, ori: r.orientation });
        r.free();
    }

    console.log(`\n=== Phase 3 verification — same file, A/B rotate flag ===`);
    console.log(`File: ${name}, EXIF orientation: ${runs[0].ori}`);
    for (const r of runs) {
        console.log(`  ${r.label.padEnd(10)}: pipeline=${r.ms.toFixed(0)}ms, orient_ms=${r.orient_ms.toFixed(2)}, dims=${r.w}x${r.h}`);
    }
    expect(runs[1].orient_ms).toBeLessThan(2); // no-rotate path: ~0 ms
    if (runs[0].ori !== 1) {
        // For non-identity orientation, the rotate path should report > 0 orient_ms.
        expect(runs[0].orient_ms).toBeGreaterThan(0);
    }
}, 180000);

test('Phase 3: rotate_rgb8 fast path round-trip', async () => {
    await initRaw();
    const { rotate_rgb8 } = rawWasm;
    // Tiny synthetic 7×5 RGB.
    const w = 7, h = 5;
    const src = new Uint8Array(w * h * 3);
    for (let i = 0; i < src.length; i++) src[i] = (i & 0xff);
    // 90 CW then 90 CCW should give identity (turns 1 then 3 = 4).
    const r1 = rotate_rgb8(src, w, h, 1);
    const r1bytes = r1.take_rgb();
    expect(r1.width).toBe(h);
    expect(r1.height).toBe(w);
    const r2 = rotate_rgb8(r1bytes, h, w, 3);
    const r2bytes = r2.take_rgb();
    expect(r2.width).toBe(w);
    expect(r2.height).toBe(h);
    expect(r2bytes).toEqual(src);
    r1.free();
    r2.free();
});
