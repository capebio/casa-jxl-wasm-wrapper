/**
 * P3.1 feature benchmark: previewFirst, region/downsample, JXTC extraction.
 *
 * Usage:
 *   node benchmark/p3-features-benchmark.mjs
 *   P3_LIMIT=5 P3_TARGET=1600 node benchmark/p3-features-benchmark.mjs
 *
 * Reads ORFs → progressive JXL (AC passes, effort=3) → times:
 *   1. previewFirst: DC-only ds=2 decode vs first AC pass
 *   2. downsample=2 vs full decode
 *   3. region center-50% vs full decode
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

const LIMIT  = Math.max(1, Number(process.env.P3_LIMIT  ?? "5"));
const TARGET = Number(process.env.P3_TARGET ?? "1600");  // long-edge px for encode
const EFFORT = Number(process.env.P3_EFFORT ?? "3");
const QUALITY = Number(process.env.P3_QUALITY ?? "85");

const tier = detectTier();
console.log(`[p3-bench] tier=${tier} limit=${LIMIT} target=${TARGET}px effort=${EFFORT} quality=${QUALITY}`);

const files = readdirSync(GOBABEB_DIR, { withFileTypes: true })
    .filter(e => e.isFile() && extname(e.name).toLowerCase() === ".orf")
    .map(e => ({ name: e.name, path: join(GOBABEB_DIR, e.name), size: statSync(join(GOBABEB_DIR, e.name)).size }))
    .sort((a, b) => b.size - a.size)
    .slice(0, LIMIT);

if (!files.length) throw new Error(`No ORFs in ${GOBABEB_DIR}`);
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const results = [];

for (const file of files) {
    console.log(`\n[p3-bench] ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`);

    // 1. Decode RAW
    const raw = new Uint8Array(readFileSync(file.path));
    const decoded = process_orf_with_flags(raw, OUTPUT_FULL_RGB, ...PROCESS_ARGS);
    let jxlBytes;
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

        // 2. Encode as progressive JXL with AC passes
        const tEncode = performance.now();
        jxlBytes = await encodeProgressive(rgba, tgtW, tgtH);
        const encodeMs = performance.now() - tEncode;
        console.log(`  encode: ${encodeMs.toFixed(0)}ms  jxl=${(jxlBytes.byteLength / 1024).toFixed(0)}KB`);

        // 3. Count passes in a dry-run decode
        const passCounts = await countPasses(jxlBytes);
        console.log(`  passes: ${passCounts.progressCount} progress + 1 final (total events=${passCounts.total})`);

        // 4a. Full progressive decode (emitEveryPass=true) — baseline
        const fullDec = await timedDecode(jxlBytes, {
            format: 'rgba8', progressionTarget: 'final', emitEveryPass: true,
            progressiveDetail: 'passes', downsample: 1,
            preserveIcc: false, preserveMetadata: false,
        });
        console.log(`  full-decode: firstMs=${fullDec.firstFrameMs.toFixed(1)}ms  finalMs=${fullDec.finalMs.toFixed(1)}ms  passes=${fullDec.passCount}  ${fullDec.w}×${fullDec.h}`);

        // 4b. DC-only at ds=2 (the "previewFirst" half — just the preview decode)
        const previewDec = await timedDecode(jxlBytes, {
            format: 'rgba8', progressionTarget: 'final', emitEveryPass: false,
            progressiveDetail: 'dc', downsample: 2,
            preserveIcc: false, preserveMetadata: false,
        });
        console.log(`  preview-dc-ds2: finalMs=${previewDec.finalMs.toFixed(1)}ms  ${previewDec.w}×${previewDec.h}`);

        const previewSpeedup = fullDec.firstFrameMs > 0
            ? (fullDec.firstFrameMs / previewDec.finalMs).toFixed(2) : "n/a";
        const verdict = Number(previewSpeedup) > 1 ? "FASTER ✓" : "SLOWER ✗";
        console.log(`  → previewFirst vs first-pass: ${previewSpeedup}x (${verdict})`);

        // 5. Downsample=2 full image
        const ds2Dec = await timedDecode(jxlBytes, {
            format: 'rgba8', progressionTarget: 'final', emitEveryPass: false,
            progressiveDetail: 'dc', downsample: 2,
            preserveIcc: false, preserveMetadata: false,
        });
        const ds2Speedup = (fullDec.finalMs / ds2Dec.finalMs).toFixed(2);
        console.log(`  ds2-full: finalMs=${ds2Dec.finalMs.toFixed(1)}ms  speedup=${ds2Speedup}x`);

        // 6. Region center 50%
        const region = {
            x: Math.floor(fullDec.w * 0.25),
            y: Math.floor(fullDec.h * 0.25),
            w: Math.floor(fullDec.w * 0.5),
            h: Math.floor(fullDec.h * 0.5),
        };
        const regionDec = await timedDecode(jxlBytes, {
            format: 'rgba8', progressionTarget: 'final', emitEveryPass: false,
            progressiveDetail: 'dc', downsample: 1, region,
            preserveIcc: false, preserveMetadata: false,
        });
        const regionSpeedup = (fullDec.finalMs / regionDec.finalMs).toFixed(2);
        console.log(`  region-center50: finalMs=${regionDec.finalMs.toFixed(1)}ms  speedup=${regionSpeedup}x  ${regionDec.w}×${regionDec.h}`);

        // 7. Region + ds=2
        const regionDs2Dec = await timedDecode(jxlBytes, {
            format: 'rgba8', progressionTarget: 'final', emitEveryPass: false,
            progressiveDetail: 'dc', downsample: 2, region,
            preserveIcc: false, preserveMetadata: false,
        });
        const regionDs2Speedup = (fullDec.finalMs / regionDs2Dec.finalMs).toFixed(2);
        console.log(`  region+ds2: finalMs=${regionDs2Dec.finalMs.toFixed(1)}ms  speedup=${regionDs2Speedup}x  ${regionDs2Dec.w}×${regionDs2Dec.h}`);

        results.push({
            file: file.name,
            rawSizeMb: (file.size / 1024 / 1024).toFixed(1),
            src: `${srcW}×${srcH}`,
            encoded: `${tgtW}×${tgtH}`,
            jxlKb: Math.round(jxlBytes.byteLength / 1024),
            encodeMs: Math.round(encodeMs),
            passes: passCounts.total,
            fullDecode: { firstFrameMs: +fullDec.firstFrameMs.toFixed(1), finalMs: +fullDec.finalMs.toFixed(1), passes: fullDec.passCount },
            previewDcDs2: { finalMs: +previewDec.finalMs.toFixed(1), speedupVsFirstPass: +previewSpeedup },
            ds2Full: { finalMs: +ds2Dec.finalMs.toFixed(1), speedup: +ds2Speedup },
            regionCenter50: { finalMs: +regionDec.finalMs.toFixed(1), speedup: +regionSpeedup },
            regionDs2: { finalMs: +regionDs2Dec.finalMs.toFixed(1), speedup: +regionDs2Speedup },
        });
    } finally {
        decoded.free();
    }
}

// Summary table
console.log("\n=== SUMMARY ===");
console.log("file                         | full-final | preview-dc-ds2 | preview-speedup | ds2  | region50 | reg+ds2");
console.log("-----------------------------+------------+----------------+-----------------+------+----------+--------");
for (const r of results) {
    const name = r.file.padEnd(28);
    const full = `${r.fullDecode.finalMs}ms`.padEnd(10);
    const prev = `${r.previewDcDs2.finalMs}ms`.padEnd(14);
    const spd = `${r.previewDcDs2.speedupVsFirstPass}x (${r.previewDcDs2.speedupVsFirstPass > 1 ? "✓" : "✗"})`.padEnd(15);
    const ds2 = `${r.ds2Full.speedup}x`.padEnd(4);
    const reg = `${r.regionCenter50.speedup}x`.padEnd(8);
    const rds2 = `${r.regionDs2.speedup}x`;
    console.log(`${name} | ${full} | ${prev} | ${spd} | ${ds2} | ${reg} | ${rds2}`);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outPath = join(OUT_DIR, `p3-features-benchmark-${stamp}.json`);
writeFileSync(outPath, JSON.stringify({
    exportedAt: new Date().toISOString(),
    tier, target: TARGET, effort: EFFORT, quality: QUALITY, results,
}, null, 2));
console.log(`\n[p3-bench] wrote ${outPath}`);

// --- helpers ---

async function encodeProgressive(rgba, width, height) {
    const encoder = createEncoder({
        format: 'rgba8', width, height, hasAlpha: false,
        iccProfile: null, exif: null, xmp: null,
        distance: null, quality: QUALITY, effort: EFFORT,
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
    let progressCount = 0, total = 0;
    try {
        const evTask = (async () => {
            for await (const ev of decoder.events()) {
                if (ev.type === 'progress') { progressCount++; total++; }
                else if (ev.type === 'final') total++;
                else if (ev.type === 'error') throw new Error(`${ev.code}: ${ev.message}`);
            }
        })();
        await decoder.push(exactBuffer(jxl));
        await decoder.close();
        await evTask;
    } finally {
        try { await decoder.dispose(); } catch (_) {}
    }
    return { progressCount, total };
}

async function timedDecode(jxl, options) {
    const decoder = createDecoder(options);
    let firstFrameMs = null, finalMs = null, passCount = 0, w = 0, h = 0;
    const tStart = performance.now();
    try {
        const evTask = (async () => {
            for await (const ev of decoder.events()) {
                if (ev.type === 'progress' || ev.type === 'final') {
                    passCount++;
                    if (firstFrameMs === null) firstFrameMs = performance.now() - tStart;
                    if (ev.type === 'final') {
                        finalMs = performance.now() - tStart;
                        w = ev.info?.width > 0 ? ev.info.width : (ev.region?.w ?? 0);
                        h = ev.info?.height > 0 ? ev.info.height : (ev.region?.h ?? 0);
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
        passCount, w, h,
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
