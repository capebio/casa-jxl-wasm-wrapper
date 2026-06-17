/**
 * Progressive vs 1-shot timing benchmark (Test_1).
 *
 * Usage:
 *   PT_LIMIT=3 node benchmark/progressive-timing-benchmark.mjs
 *   PT_LIMIT=3 PT_SIZES=300,800,1600 PT_QUALITY=85 PT_EFFORT=3 node benchmark/progressive-timing-benchmark.mjs
 *
 * For each file × size:
 *   - Encodes as progressive JXL (AC passes) and 1-shot JXL
 *   - Decodes both; records first-frame arrival (progressive) vs final (1-shot)
 *   - Also decodes progressive in chunked mode (PT_STEPS equal slices) to simulate streaming
 *
 * Key question: does progressive first-frame arrive faster than 1-shot final?
 *
 * Results written to docs/outputs/timing tests/<datetime>-progressive-timing.toon
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { performance } from "node:perf_hooks";

import initRaw, { downscale_rgb, process_orf_with_flags, rgb_to_rgba } from "../pkg/raw_converter_wasm.js";
import { createDecoder, createEncoder, getForcedTier, setForcedTier } from "../packages/jxl-wasm/dist/index.js";

setForcedTier("simd");

await initRaw({ module_or_path: readFileSync(new URL("../pkg/raw_converter_wasm_bg.wasm", import.meta.url)) });

const GOBABEB_DIR = String.raw`C:\995\2026-02-20 Gobabeb To Windhoek`;
const OUT_DIR    = String.raw`C:\Foo\raw-converter-wasm\docs\outputs\timing tests`;
const OUTPUT_FULL_RGB = 1;
const PROCESS_ARGS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Number.NaN, Number.NaN, 0, 0];

const LIMIT   = Math.max(1, Number(process.env.PT_LIMIT   ?? "3"));
const QUALITY = Number(process.env.PT_QUALITY ?? "85");
const EFFORT  = Number(process.env.PT_EFFORT  ?? "3");
const SIZES   = (process.env.PT_SIZES ?? "300,800,1600").split(",").map(Number);
const STEPS   = (process.env.PT_STEPS ?? "1,4,8").split(",").map(Number);

const tier = getForcedTier() ?? "auto";
console.log(`[prog-timing] tier=${tier} limit=${LIMIT} sizes=${SIZES.join(",")} quality=${QUALITY} effort=${EFFORT} steps=${STEPS.join(",")}`);

const files = readdirSync(GOBABEB_DIR, { withFileTypes: true })
    .filter(e => e.isFile() && extname(e.name).toLowerCase() === ".orf")
    .map(e => ({ name: e.name, path: join(GOBABEB_DIR, e.name), size: statSync(join(GOBABEB_DIR, e.name)).size }))
    .sort((a, b) => b.size - a.size)
    .slice(0, LIMIT);

if (!files.length) throw new Error(`No ORFs in ${GOBABEB_DIR}`);
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

// All permutation blocks for TOON output
const permutations = [];

for (const file of files) {
    console.log(`\n[prog-timing] ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`);

    const raw = new Uint8Array(readFileSync(file.path));
    const decoded = process_orf_with_flags(raw, OUTPUT_FULL_RGB, ...PROCESS_ARGS);
    const rawMs = 0; // RAW decode is synchronous; not timed separately
    try {
        const rgb = decoded.take_rgb();
        const srcW = decoded.width;
        const srcH = decoded.height;

        for (const target of SIZES) {
            const longEdge = Math.max(srcW, srcH);
            const scale = longEdge > target ? target / longEdge : 1;
            const tgtW = Math.round(srcW * scale);
            const tgtH = Math.round(srcH * scale);
            const rgba = scale < 1
                ? rgb_to_rgba(downscale_rgb(rgb, srcW, srcH, tgtW, tgtH))
                : rgb_to_rgba(rgb);

            console.log(`  size=${target}px → ${tgtW}×${tgtH}`);

            // --- Encode progressive ---
            const tProgEnc = performance.now();
            const progBytes = await encodeJxl(rgba, tgtW, tgtH, { progressive: true });
            const progEncMs = performance.now() - tProgEnc;

            // --- Encode 1-shot ---
            const tShotEnc = performance.now();
            const shotBytes = await encodeJxl(rgba, tgtW, tgtH, { progressive: false });
            const shotEncMs = performance.now() - tShotEnc;

            console.log(`    prog enc=${progEncMs.toFixed(0)}ms ${(progBytes.byteLength/1024).toFixed(0)}KB  shot enc=${shotEncMs.toFixed(0)}ms ${(shotBytes.byteLength/1024).toFixed(0)}KB`);

            // --- Decode: progressive full push ---
            const progDec = await timedDecode(progBytes, {
                format: 'rgba8', progressionTarget: 'final', emitEveryPass: true,
                progressiveDetail: 'passes', downsample: 1,
                preserveIcc: false, preserveMetadata: false,
            });
            console.log(`    prog-full: first=${progDec.firstMs.toFixed(1)}ms final=${progDec.finalMs.toFixed(1)}ms passes=${progDec.passes}`);

            // --- Decode: 1-shot ---
            const shotDec = await timedDecode(shotBytes, {
                format: 'rgba8', progressionTarget: 'final', emitEveryPass: false,
                progressiveDetail: 'passes', downsample: 1,
                preserveIcc: false, preserveMetadata: false,
            });
            console.log(`    shot-full: final=${shotDec.finalMs.toFixed(1)}ms`);

            const speedupVsShot = shotDec.finalMs > 0 ? (shotDec.finalMs / progDec.firstMs) : null;
            console.log(`    → prog first vs shot final: ${speedupVsShot?.toFixed(2)}x (${speedupVsShot >= 1 ? "FASTER ✓" : "SLOWER ✗"})`);

            // Record in permutation blocks for this file×size
            const perm = {
                file: file.name,
                srcDim: `${srcW}×${srcH}`,
                encDim: `${tgtW}×${tgtH}`,
                target,
                progEncMs: Math.round(progEncMs),
                progKb: Math.round(progBytes.byteLength / 1024),
                progPasses: progDec.passes,
                progFirstMs: Math.round(progDec.firstMs),
                progFinalMs: Math.round(progDec.finalMs),
                shotEncMs: Math.round(shotEncMs),
                shotKb: Math.round(shotBytes.byteLength / 1024),
                shotFinalMs: Math.round(shotDec.finalMs),
                speedup: speedupVsShot !== null ? +speedupVsShot.toFixed(2) : null,
                chunked: [],
            };

            // --- Chunked stream decode ---
            for (const steps of STEPS) {
                if (steps <= 1) continue; // already have full-push above

                const chunkDec = await timedChunkedDecode(progBytes, steps, {
                    format: 'rgba8', progressionTarget: 'final', emitEveryPass: true,
                    progressiveDetail: 'passes', downsample: 1,
                    preserveIcc: false, preserveMetadata: false,
                });
                console.log(`    prog-chunked(${steps}): first=${chunkDec.firstMs.toFixed(1)}ms final=${chunkDec.finalMs.toFixed(1)}ms`);
                perm.chunked.push({ steps, firstMs: Math.round(chunkDec.firstMs), finalMs: Math.round(chunkDec.finalMs) });
            }

            permutations.push(perm);
        }
    } finally {
        decoded.free();
    }
}

// --- Build TOON output ---
const runTs = new Date().toISOString();
const lines = [];

lines.push(`TestName: progressive-timing`);
lines.push(`RunTimestamp: ${runTs}`);
lines.push(`Agent: claude-sonnet-4-6`);
lines.push(`Tier: ${tier}`);
lines.push(`Sizes: ${SIZES.join(", ")}`);
lines.push(`Quality: ${QUALITY}`);
lines.push(`Effort: ${EFFORT}`);
lines.push(`Steps: ${STEPS.join(", ")}`);
lines.push(``);

// Group by size for clarity
for (const target of SIZES) {
    const group = permutations.filter(p => p.target === target);
    if (!group.length) continue;

    // --- Progressive full-push permutation ---
    lines.push(`---`);
    lines.push(`Permutation: mode=progressive, detail=passes, steps=1, size=${target}px, quality=${QUALITY}, effort=${EFFORT}`);
    lines.push(`Timestamp: ${new Date().toISOString()}`);
    lines.push(`rows[${group.length}]{file,encode_ms,passes,first_ms,final_ms,size_kb}:`);
    for (const p of group) {
        lines.push(`  ${p.file},${p.progEncMs},${p.progPasses},${p.progFirstMs},${p.progFinalMs},${p.progKb}`);
    }
    const avgFirst = Math.round(group.reduce((s, p) => s + p.progFirstMs, 0) / group.length);
    const avgFinal = Math.round(group.reduce((s, p) => s + p.progFinalMs, 0) / group.length);
    lines.push(``);
    lines.push(`# Aggregates`);
    lines.push(`avg_first_ms: ${avgFirst}`);
    lines.push(`avg_final_ms: ${avgFinal}`);
    lines.push(``);

    // --- 1-shot permutation ---
    lines.push(`---`);
    lines.push(`Permutation: mode=oneshot, steps=1, size=${target}px, quality=${QUALITY}, effort=${EFFORT}`);
    lines.push(`Timestamp: ${new Date().toISOString()}`);
    lines.push(`rows[${group.length}]{file,encode_ms,final_ms,size_kb}:`);
    for (const p of group) {
        lines.push(`  ${p.file},${p.shotEncMs},${p.shotFinalMs},${p.shotKb}`);
    }
    const avgShot = Math.round(group.reduce((s, p) => s + p.shotFinalMs, 0) / group.length);
    const avgSpeedup = (group.reduce((s, p) => s + (p.speedup ?? 1), 0) / group.length).toFixed(2);
    lines.push(``);
    lines.push(`# Aggregates`);
    lines.push(`avg_final_ms: ${avgShot}`);
    lines.push(``);
    lines.push(`# vs-progressive`);
    lines.push(`avg_prog_first_ms: ${avgFirst}`);
    lines.push(`avg_oneshot_ms: ${avgShot}`);
    lines.push(`avg_speedup: ${avgSpeedup}x  # progressive first-frame vs 1-shot final`);
    lines.push(``);

    // --- Chunked permutations ---
    for (const steps of STEPS) {
        if (steps <= 1) continue;
        const hasChunked = group.some(p => p.chunked.some(c => c.steps === steps));
        if (!hasChunked) continue;

        lines.push(`---`);
        lines.push(`Permutation: mode=progressive, detail=passes, steps=${steps}, size=${target}px, quality=${QUALITY}, effort=${EFFORT}`);
        lines.push(`Timestamp: ${new Date().toISOString()}`);
        lines.push(`rows[${group.length}]{file,first_ms,final_ms}:`);
        for (const p of group) {
            const c = p.chunked.find(c => c.steps === steps);
            if (c) lines.push(`  ${p.file},${c.firstMs},${c.finalMs}`);
        }
        const chunkedRows = group.map(p => p.chunked.find(c => c.steps === steps)).filter(Boolean);
        const avgChFirst = Math.round(chunkedRows.reduce((s, c) => s + c.firstMs, 0) / chunkedRows.length);
        lines.push(``);
        lines.push(`# Aggregates`);
        lines.push(`avg_first_ms: ${avgChFirst}`);
        lines.push(``);
    }
}

// --- Summary table to console ---
console.log("\n=== SUMMARY: progressive first-frame vs 1-shot final ===");
console.log("file                         size  prog-first  shot-final  speedup  verdict");
console.log("-----------------------------+-----+-----------+-----------+--------+-------");
for (const p of permutations) {
    const name = p.file.padEnd(28);
    const sz = `${p.target}px`.padEnd(5);
    const pf = `${p.progFirstMs}ms`.padEnd(10);
    const sf = `${p.shotFinalMs}ms`.padEnd(10);
    const sp = p.speedup !== null ? `${p.speedup}x`.padEnd(7) : "n/a".padEnd(7);
    const v = p.speedup !== null && p.speedup >= 1 ? "✓ FASTER" : "✗ SLOWER";
    console.log(`${name} ${sz} ${pf} ${sf} ${sp} ${v}`);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "Z");
const outPath = join(OUT_DIR, `${stamp}-progressive-timing.toon`);
writeFileSync(outPath, lines.join("\n") + "\n");
console.log(`\n[prog-timing] wrote ${outPath}`);
process.exit(0);

// --- helpers ---

async function encodeJxl(rgba, width, height, { progressive }) {
    const encoder = createEncoder({
        format: 'rgba8', width, height, hasAlpha: false,
        iccProfile: null, exif: null, xmp: null,
        distance: null, quality: QUALITY, effort: EFFORT,
        progressive, progressiveFlavor: progressive ? 'ac' : undefined, previewFirst: false,
        chunked: true,
    });
    const chunks = [];
    const chunkTask = (async () => {
        for await (const chunk of encoder.chunks())
            chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    })();
    await encoder.pushPixels(exactBuffer(rgba));
    await encoder.finish();
    await chunkTask;
    await encoder.dispose();
    return concatChunks(chunks);
}

async function timedDecode(jxl, options) {
    const decoder = createDecoder(options);
    let firstMs = null, finalMs = null, passes = 0;
    const t0 = performance.now();
    try {
        const evTask = (async () => {
            for await (const ev of decoder.events()) {
                if (ev.type === 'progress' || ev.type === 'final') {
                    passes++;
                    if (firstMs === null) firstMs = performance.now() - t0;
                    if (ev.type === 'final') finalMs = performance.now() - t0;
                } else if (ev.type === 'error') {
                    throw new Error(`${ev.code}: ${ev.message}`);
                }
            }
        })();
        await decoder.push(exactBuffer(jxl));
        await decoder.close();
        await evTask;
    } finally {
        try { await decoder.dispose(); } catch (_) {}
    }
    const elapsed = performance.now() - t0;
    return { firstMs: firstMs ?? elapsed, finalMs: finalMs ?? elapsed, passes };
}

async function timedChunkedDecode(jxl, steps, options) {
    const decoder = createDecoder(options);
    let firstMs = null, finalMs = null;
    const t0 = performance.now();
    try {
        const evTask = (async () => {
            for await (const ev of decoder.events()) {
                if (ev.type === 'progress' || ev.type === 'final') {
                    if (firstMs === null) firstMs = performance.now() - t0;
                    if (ev.type === 'final') finalMs = performance.now() - t0;
                } else if (ev.type === 'error') {
                    // truncation error expected for incomplete steps — ignore
                }
            }
        })();
        const chunkSize = Math.ceil(jxl.byteLength / steps);
        for (let i = 0; i < steps; i++) {
            const start = i * chunkSize;
            const end = Math.min(start + chunkSize, jxl.byteLength);
            await decoder.push(exactBuffer(jxl.subarray(start, end)));
        }
        await decoder.close();
        await evTask;
    } finally {
        try { await decoder.dispose(); } catch (_) {}
    }
    const elapsed = performance.now() - t0;
    return { firstMs: firstMs ?? elapsed, finalMs: finalMs ?? elapsed };
}

function exactBuffer(view) {
    if (view instanceof ArrayBuffer) return view;
    if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view.buffer;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

function concatChunks(chunks) {
    const total = chunks.reduce((s, c) => s + c.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    return out;
}
