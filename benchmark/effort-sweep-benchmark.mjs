/**
 * Effort sweep benchmark: compare effort levels 3, 5, 7.
 *
 * Usage:
 *   EFFORT_LIMIT=2 EFFORT_TARGET=1600 node benchmark/effort-sweep-benchmark.mjs
 *
 * Encodes ORFs at effort levels 3, 5, 7 and measures:
 *   - Encode time and file size
 *   - Decode: first pass arrival time, total time
 *   - Visual quality comparison
 *
 * Results written to docs/Benchmark results/effort-sweep-benchmark-TIMESTAMP.json
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { performance } from "node:perf_hooks";

import initRaw, { downscale_rgb, process_orf_with_flags, rgb_to_rgba } from "../pkg/raw_converter_wasm.js";

if (typeof globalThis.Worker === "undefined" && !process.env.JXL_WASM_FORCE_TIER) {
    process.env.JXL_WASM_FORCE_TIER = "simd";
}
const { createDecoder, createEncoder, detectTier } = await import("../packages/jxl-wasm/dist/index.js");

await initRaw({ module_or_path: readFileSync(new URL("../pkg/raw_converter_wasm_bg.wasm", import.meta.url)) });

const GOBABEB_DIR = String.raw`C:\995\2026-02-20 Gobabeb To Windhoek`;
const OUT_DIR = String.raw`C:\Foo\raw-converter-wasm\docs\Benchmark results`;
const OUTPUT_FULL_RGB = 1;
const PROCESS_ARGS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Number.NaN, Number.NaN, 0, 0];

const LIMIT = Math.max(1, Number(process.env.EFFORT_LIMIT ?? "2"));
const TARGET = Number(process.env.EFFORT_TARGET ?? "1600");
const QUALITY = Number(process.env.EFFORT_QUALITY ?? "85");
const EFFORTS = [3, 5, 7];

const tier = detectTier();
console.log(`[effort-sweep] tier=${tier} limit=${LIMIT} target=${TARGET}px quality=${QUALITY} efforts=${EFFORTS.join(",")}`);

const files = readdirSync(GOBABEB_DIR, { withFileTypes: true })
    .filter(e => e.isFile() && extname(e.name).toLowerCase() === ".orf")
    .map(e => ({ name: e.name, path: join(GOBABEB_DIR, e.name), size: statSync(join(GOBABEB_DIR, e.name)).size }))
    .sort((a, b) => b.size - a.size)
    .slice(0, LIMIT);

if (!files.length) throw new Error(`No ORFs in ${GOBABEB_DIR}`);
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const results = [];

for (const file of files) {
    console.log(`\n[effort-sweep] ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`);

    const raw = new Uint8Array(readFileSync(file.path));
    const decoded = process_orf_with_flags(raw, OUTPUT_FULL_RGB, ...PROCESS_ARGS);
    try {
        const rgb = decoded.take_rgb();
        const srcW = decoded.width;
        const srcH = decoded.height;

        // Scale to target long edge
        const longEdge = Math.max(srcW, srcH);
        const scale = longEdge > TARGET ? TARGET / longEdge : 1;
        const tgtW = Math.round(srcW * scale);
        const tgtH = Math.round(srcH * scale);
        const rgba = scale < 1
            ? rgb_to_rgba(downscale_rgb(rgb, srcW, srcH, tgtW, tgtH))
            : rgb_to_rgba(rgb);

        console.log(`  raw ${srcW}×${srcH} → encode ${tgtW}×${tgtH}`);

        const effortResults = [];

        for (const effort of EFFORTS) {
            console.log(`  effort=${effort}...`);

            // Encode
            const tEncode = performance.now();
            const jxlBytes = await encodeProgressive(rgba, tgtW, tgtH, effort);
            const encodeMs = performance.now() - tEncode;
            const jxlKb = (jxlBytes.byteLength / 1024).toFixed(0);

            // Count passes
            const passCount = await countPasses(jxlBytes);

            // Decode timings
            const decodeResult = await timedDecode(jxlBytes, {
                format: 'rgba8', progressionTarget: 'final', emitEveryPass: true,
                progressiveDetail: 'passes', downsample: 1,
                preserveIcc: false, preserveMetadata: false,
            });

            const speedupVsEffort3 = effortResults.length > 0
                ? (effortResults[0].encodeMs / encodeMs).toFixed(2)
                : "n/a";

            const speedupDecode = effortResults.length > 0
                ? (effortResults[0].decodeFinalMs / decodeResult.finalMs).toFixed(2)
                : "n/a";

            console.log(`    encode=${encodeMs.toFixed(0)}ms jxl=${jxlKb}KB passes=${passCount} decode-first=${decodeResult.firstFrameMs.toFixed(1)}ms decode-final=${decodeResult.finalMs.toFixed(1)}ms`);

            effortResults.push({
                effort,
                encodeMs: Math.round(encodeMs),
                jxlBytes: jxlBytes.byteLength,
                jxlKb: Math.round(jxlBytes.byteLength / 1024),
                passes: passCount,
                decodeFirstMs: Math.round(decodeResult.firstFrameMs),
                decodeFinalMs: Math.round(decodeResult.finalMs),
                encodeSpeedupVsEffort3: speedupVsEffort3,
                decodeSpeedupVsEffort3: speedupDecode,
            });
        }

        // Summary
        const e3 = effortResults[0];
        const e5 = effortResults[1];
        const e7 = effortResults[2];
        console.log(`  summary:`);
        console.log(`    effort=3: encode=${e3.encodeMs}ms jxl=${e3.jxlKb}KB decode=${e3.decodeFinalMs}ms`);
        console.log(`    effort=5: encode=${e5.encodeMs}ms (${((e5.encodeMs - e3.encodeMs) / e3.encodeMs * 100).toFixed(0)}% slower) jxl=${e5.jxlKb}KB (${((e5.jxlBytes - e3.jxlBytes) / e3.jxlBytes * 100).toFixed(0)}% smaller) decode=${e5.decodeFinalMs}ms`);
        console.log(`    effort=7: encode=${e7.encodeMs}ms (${((e7.encodeMs - e3.encodeMs) / e3.encodeMs * 100).toFixed(0)}% slower) jxl=${e7.jxlKb}KB (${((e7.jxlBytes - e3.jxlBytes) / e3.jxlBytes * 100).toFixed(0)}% smaller) decode=${e7.decodeFinalMs}ms`);

        const verdict = (() => {
            const e5Worth = (e5.encodeMs - e3.encodeMs) < 300 && (e3.jxlBytes - e5.jxlBytes) > (e3.jxlBytes * 0.05) ? "CONSIDER" : "SKIP";
            return e5Worth;
        })();
        console.log(`  → effort=5 worth +${(e5.encodeMs - e3.encodeMs).toFixed(0)}ms encode for ${((e3.jxlBytes - e5.jxlBytes) / 1024).toFixed(0)}KB savings? ${verdict}`);

        results.push({
            file: file.name,
            src: `${srcW}×${srcH}`,
            encoded: `${tgtW}×${tgtH}`,
            efforts: effortResults,
        });
    } finally {
        decoded.free();
    }
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outPath = join(OUT_DIR, `effort-sweep-benchmark-${stamp}.json`);
writeFileSync(outPath, JSON.stringify({
    exportedAt: new Date().toISOString(),
    tier, target: TARGET, quality: QUALITY, efforts: EFFORTS, results,
}, null, 2));
console.log(`\n[effort-sweep] wrote ${outPath}`);

// --- helpers ---

async function encodeProgressive(rgba, width, height, effort) {
    const encoder = createEncoder({
        format: 'rgba8', width, height, hasAlpha: false,
        iccProfile: null, exif: null, xmp: null,
        distance: null, quality: QUALITY, effort,
        progressive: true, progressiveFlavor: 'ac', previewFirst: false,
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

async function countPasses(jxl) {
    const decoder = createDecoder({
        format: 'rgba8', progressionTarget: 'final', emitEveryPass: true,
        progressiveDetail: 'passes', downsample: 1,
        preserveIcc: false, preserveMetadata: false,
    });
    let passCount = 0;
    try {
        const evTask = (async () => {
            for await (const ev of decoder.events()) {
                if (ev.type === 'progress') passCount++;
                else if (ev.type === 'final') passCount++;
                else if (ev.type === 'error') throw new Error(`${ev.code}: ${ev.message}`);
            }
        })();
        await decoder.push(exactBuffer(jxl));
        await decoder.close();
        await evTask;
    } finally {
        try { await decoder.dispose(); } catch (_) {}
    }
    return passCount;
}

async function timedDecode(jxl, options) {
    const decoder = createDecoder(options);
    let firstFrameMs = null, finalMs = null, passCount = 0;
    const tStart = performance.now();
    try {
        const evTask = (async () => {
            for await (const ev of decoder.events()) {
                if (ev.type === 'progress' || ev.type === 'final') {
                    passCount++;
                    if (firstFrameMs === null) firstFrameMs = performance.now() - tStart;
                    if (ev.type === 'final') {
                        finalMs = performance.now() - tStart;
                    }
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
    const elapsed = performance.now() - tStart;
    return {
        firstFrameMs: firstFrameMs ?? elapsed,
        finalMs: finalMs ?? elapsed,
        passCount,
    };
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
