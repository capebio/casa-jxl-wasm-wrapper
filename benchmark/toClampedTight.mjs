// Flip-flop benchmark for the jxl-decode-worker pixel-normalisation change.
//
// OLD path (pre-review): force pixels to a Uint8Array, then copy again if the
//   view was offset/partial. When the decoder emits a Uint8ClampedArray this
//   ALWAYS performed a full-frame copy — and produced the wrong type for
//   `new ImageData(...)` on the main thread (which requires Uint8ClampedArray).
//
// NEW path (toClampedTight): returns a tight, ImageData-ready Uint8ClampedArray.
//   - clamped tight input        -> returned as-is        (0 copy)
//   - tight Uint8Array input     -> re-wrap same buffer    (0 copy)
//   - offset/partial view input  -> copy exact bytes       (1 copy, unavoidable)
//
// Alternates NEW vs OLD ten times per scenario; emits per-run timing + CPU.
// Thermals: not exposed by Windows without extra tooling — omitted (noted).

import os from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

// ---- the two implementations under test -----------------------------------

function oldNormalize(pixels) {
    let px = pixels instanceof Uint8Array ? pixels : new Uint8Array(pixels);
    if (px.byteOffset !== 0 || px.byteLength !== px.buffer.byteLength) px = new Uint8Array(px);
    return px;
}

function toClampedTight(pixels) {
    if (pixels instanceof Uint8ClampedArray
        && pixels.byteOffset === 0
        && pixels.byteLength === pixels.buffer.byteLength) {
        return pixels;
    }
    if (pixels instanceof Uint8Array
        && pixels.byteOffset === 0
        && pixels.byteLength === pixels.buffer.byteLength) {
        return new Uint8ClampedArray(pixels.buffer);
    }
    return new Uint8ClampedArray(
        (pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray)
            ? pixels
            : new Uint8Array(pixels),
    );
}

// ---- scenarios -------------------------------------------------------------
// Each makeSource() returns a *fresh* source each round so a real copy is paid
// when the implementation copies (transfer would detach in production anyway).

const MP24 = { w: 6000, h: 4000 };          // ~96 MB RGBA — full-res lightbox
const MP2  = { w: 1920, h: 1280 };          // ~9.8 MB RGBA — typical progressive frame

function rgbaBytes(dim) { return dim.w * dim.h * 4; }

const SCENARIOS = [
    {
        key: 'clamped-tight-24MP',
        note: 'decoder emits Uint8ClampedArray (OLD copies full frame, NEW 0-copy)',
        makeSource: () => new Uint8ClampedArray(rgbaBytes(MP24)),
    },
    {
        key: 'clamped-tight-2MP',
        note: 'decoder emits Uint8ClampedArray, progressive frame size',
        makeSource: () => new Uint8ClampedArray(rgbaBytes(MP2)),
    },
    {
        key: 'u8-tight-24MP',
        note: 'decoder emits tight Uint8Array (both 0-copy; NEW fixes type)',
        makeSource: () => new Uint8Array(rgbaBytes(MP24)),
    },
    {
        key: 'heap-view-24MP',
        note: 'decoder emits a partial view into a larger buffer (both copy)',
        makeSource: () => {
            const big = new ArrayBuffer(rgbaBytes(MP24) + 4096);
            return new Uint8Array(big, 256, rgbaBytes(MP24));
        },
    },
];

const ROUNDS = 10;

function timeOnce(fn, source) {
    const t0 = performance.now();
    const out = fn(source);
    // Touch one byte so the optimiser cannot elide the work.
    const sink = out.length ? out[0] : 0;
    return { ms: performance.now() - t0, sink };
}

// ---- run -------------------------------------------------------------------

const results = [];
for (const sc of SCENARIOS) {
    for (let r = 0; r < ROUNDS; r++) {
        // Alternate NEW / OLD each round (flip-flop), fresh source each time.
        const newRes = timeOnce(toClampedTight, sc.makeSource());
        const oldRes = timeOnce(oldNormalize, sc.makeSource());
        results.push({ key: sc.key, round: r + 1, newMs: newRes.ms, oldMs: oldRes.ms });
    }
}

function median(xs) {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

console.log('\n=== toClampedTight flip-flop (NEW=toClampedTight, OLD=force-Uint8Array) ===');
console.log(`CPU: ${os.cpus()[0]?.model || 'Unknown'} x${os.cpus().length}`);
console.log(`loadavg: ${os.loadavg().map(n => n.toFixed(2)).join(', ')} | freeMem ${(os.freemem() / 1e9).toFixed(1)}GB`);
for (const sc of SCENARIOS) {
    const rows = results.filter(r => r.key === sc.key);
    const newMed = median(rows.map(r => r.newMs));
    const oldMed = median(rows.map(r => r.oldMs));
    const speedup = newMed > 0 ? (oldMed / newMed) : Infinity;
    console.log(
        `\n[${sc.key}] ${sc.note}\n` +
        `  NEW median ${newMed.toFixed(3)} ms | OLD median ${oldMed.toFixed(3)} ms | ` +
        `OLD/NEW ${Number.isFinite(speedup) ? speedup.toFixed(1) + 'x' : '∞'}`,
    );
}

// ---- emit .toon ------------------------------------------------------------

function pad(n) { return String(n).padStart(2, '0'); }
const now = new Date();
const stamp = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}T` +
    `${pad(now.getUTCHours())}-${pad(now.getUTCMinutes())}-${pad(now.getUTCSeconds())}Z`;

const outDir = join(process.cwd(), 'docs', 'outputs', 'timing tests');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `toClampedTight-flipflop-${stamp}.toon`);

let toon = '';
toon += 'TestName: toClampedTight-flipflop\n';
toon += `RunTimestamp: ${stamp}\n`;
toon += 'Agent: claude\n';
toon += `CPU: ${os.cpus()[0]?.model || 'Unknown'} x${os.cpus().length}\n`;
toon += `FreeMemGb: ${(os.freemem() / 1e9).toFixed(1)}\n`;
toon += 'Thermals: unavailable (no Windows sensor tooling in harness)\n';
toon += 'Units: ms\n';
toon += '\n---\n';
toon += `runs[${results.length}]{key|round|new_ms|old_ms}:\n`;
for (const r of results) {
    toon += `  ${r.key} | ${r.round} | ${r.newMs.toFixed(3)} | ${r.oldMs.toFixed(3)}\n`;
}
toon += '\n# Aggregates\n';
for (const sc of SCENARIOS) {
    const rows = results.filter(r => r.key === sc.key);
    toon += `${sc.key}_newMedianMs: ${median(rows.map(r => r.newMs)).toFixed(3)}\n`;
    toon += `${sc.key}_oldMedianMs: ${median(rows.map(r => r.oldMs)).toFixed(3)}\n`;
}

writeFileSync(outPath, toon);
console.log(`\nWrote ${outPath}`);
