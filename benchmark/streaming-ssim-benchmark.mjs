/**
 * Streaming SSIM benchmark: progressive byte-cutoff visual quality assessment.
 *
 * Usage:
 *   SSIM_LIMIT=2 SSIM_TARGET=1600 node benchmark/streaming-ssim-benchmark.mjs
 *   USE_BUTTERAUGLI=1 BUTTERAUGLI_THRESHOLD=1.5 node benchmark/streaming-ssim-benchmark.mjs
 *
 * Encodes ORFs as progressive JXL (effort=3), streams decode at byte cutoffs,
 * and measures visual quality (SSIM + PSNR + optional Butteraugli) vs. full reference decode.
 * Identifies "acceptable frame" threshold (SSIM > threshold or Butteraugli < threshold).
 *
 * Results written to docs/Benchmark results/streaming-ssim-benchmark-TIMESTAMP.json
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { performance } from "node:perf_hooks";
import SSIM from "ssim.js";

import initRaw, { downscale_rgb, process_orf_with_flags, rgb_to_rgba } from "../pkg/raw_converter_wasm.js";
import { buildByteCutoffPlan } from "../web/jxl-byte-cutoff-probe.js";
import { computeButteraugli, createDecoder, createEncoder, getForcedTier, setForcedTier } from "../packages/jxl-wasm/dist/index.js";

// Force simd tier — Node has SharedArrayBuffer so detectTier() picks MT by default,
// but MT tiers require COOP/COEP headers which aren't available in Node benchmark context.
setForcedTier("simd");

await initRaw({ module_or_path: readFileSync(new URL("../pkg/raw_converter_wasm_bg.wasm", import.meta.url)) });

const GOBABEB_DIR = String.raw`C:\995\2026-02-20 Gobabeb To Windhoek`;
const OUT_DIR = String.raw`C:\Foo\raw-converter-wasm\docs\Benchmark results`;
const OUTPUT_FULL_RGB = 1;
const PROCESS_ARGS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Number.NaN, Number.NaN, 0, 0];

const LIMIT = Math.max(1, Number(process.env.SSIM_LIMIT ?? "2"));
const TARGET = Number(process.env.SSIM_TARGET ?? "1600");
const EFFORT = Number(process.env.SSIM_EFFORT ?? "3");
const QUALITY = Number(process.env.SSIM_QUALITY ?? "85");
const SSIM_THRESHOLD = Number(process.env.SSIM_THRESHOLD ?? "0.9");
const USE_BUTTERAUGLI = process.env.USE_BUTTERAUGLI === "1" || process.env.USE_BUTTERAUGLI === "true";
const BUTTERAUGLI_THRESHOLD = Number(process.env.BUTTERAUGLI_THRESHOLD ?? "5.0");

const tier = getForcedTier() ?? "auto";
console.log(`[streaming-ssim] tier=${tier} limit=${LIMIT} target=${TARGET}px effort=${EFFORT} quality=${QUALITY} ssim-threshold=${SSIM_THRESHOLD}${USE_BUTTERAUGLI ? ` butteraugli-threshold=${BUTTERAUGLI_THRESHOLD}` : ""}`);

const files = readdirSync(GOBABEB_DIR, { withFileTypes: true })
    .filter(e => e.isFile() && extname(e.name).toLowerCase() === ".orf")
    .map(e => ({ name: e.name, path: join(GOBABEB_DIR, e.name), size: statSync(join(GOBABEB_DIR, e.name)).size }))
    .sort((a, b) => b.size - a.size)
    .slice(0, LIMIT);

if (!files.length) throw new Error(`No ORFs in ${GOBABEB_DIR}`);
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const results = [];

for (const file of files) {
    console.log(`\n[streaming-ssim] ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`);

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

        // Encode as progressive JXL
        const tEncode = performance.now();
        jxlBytes = await encodeProgressive(rgba, tgtW, tgtH);
        const encodeMs = performance.now() - tEncode;
        console.log(`  encode: ${encodeMs.toFixed(0)}ms  jxl=${(jxlBytes.byteLength / 1024).toFixed(0)}KB`);

        // Full reference decode
        console.log(`  decoding reference (full file)...`);
        const refDecode = await timedDecodeWithPixels(jxlBytes, {
            format: 'rgba8', progressionTarget: 'final', emitEveryPass: false,
            progressiveDetail: 'passes', downsample: 1,
            preserveIcc: false, preserveMetadata: false,
        });
        const refPixels = refDecode.pixels ? new Uint8ClampedArray(refDecode.pixels) : null;
        console.log(`  reference: ${refDecode.finalMs.toFixed(1)}ms  ${refDecode.w}×${refDecode.h}`);

        // Stream decode at byte cutoffs (percentage-based for progressive JXL)
        // Progressive JXL typically needs 70%+ to have visible content
        const percentCutoffs = [10, 20, 30, 40, 50, 60, 70, 80, 90];
        const plan = buildByteCutoffPlan(jxlBytes.byteLength, [], percentCutoffs);
        console.log(`  streaming at ${plan.length} cutoff points...`);
        const cutoffs = await streamDecodeCutoffs(jxlBytes, plan, refPixels, refDecode.w, refDecode.h, {
            format: 'rgba8', progressionTarget: 'final', emitEveryPass: false,
            progressiveDetail: 'passes', downsample: 1,
            preserveIcc: false, preserveMetadata: false,
        });

        // Find acceptable frame threshold
        const isAcceptable = USE_BUTTERAUGLI
            ? c => c.butteraugli !== null && c.butteraugli <= BUTTERAUGLI_THRESHOLD
            : c => c.ssim !== null && c.ssim >= SSIM_THRESHOLD;
        const acceptableFrame = cutoffs.find(isAcceptable);
        const acceptableBytes = acceptableFrame?.bytes ?? null;
        const acceptablePercent = acceptableFrame ? (acceptableBytes / jxlBytes.byteLength * 100).toFixed(1) : null;

        console.log(`  cutoff results:`);
        const logCutoff = (cutoff) => {
            if (cutoff.ssim !== null) {
                const ok = isAcceptable(cutoff);
                const mark = ok ? "✓" : "✗";
                const ba = cutoff.butteraugli !== null ? ` BA=${cutoff.butteraugli.toFixed(3)}` : "";
                console.log(`    ${(cutoff.bytes / 1024).toFixed(0)}KB (${cutoff.percent.toFixed(1)}%) → SSIM=${cutoff.ssim.toFixed(3)} PSNR=${cutoff.psnr.toFixed(1)}${ba} ${mark}`);
            } else {
                console.log(`    ${(cutoff.bytes / 1024).toFixed(0)}KB (${cutoff.percent.toFixed(1)}%) → error`);
            }
        };
        for (const cutoff of cutoffs.slice(0, 5)) logCutoff(cutoff);
        if (cutoffs.length > 5) {
            for (const cutoff of cutoffs.slice(-3)) logCutoff(cutoff);
        }

        if (acceptableBytes !== null) {
            console.log(`  acceptable-frame: ${(acceptableBytes / 1024).toFixed(0)}KB (${acceptablePercent}%)`);
        } else {
            console.log(`  acceptable-frame: NOT FOUND`);
        }

        results.push({
            file: file.name,
            src: `${srcW}×${srcH}`,
            encoded: `${tgtW}×${tgtH}`,
            jxlKb: Math.round(jxlBytes.byteLength / 1024),
            encodeMs: Math.round(encodeMs),
            referenceDecodeMs: Math.round(refDecode.finalMs),
            cutoffs: cutoffs.map(c => ({
                bytes: c.bytes,
                percent: +c.percent.toFixed(1),
                ssim: c.ssim !== null ? +c.ssim.toFixed(4) : null,
                psnr: c.psnr !== null ? +c.psnr.toFixed(1) : null,
                butteraugli: c.butteraugli !== null ? +c.butteraugli.toFixed(4) : null,
                error: c.error,
            })),
            acceptableBytes: acceptableBytes,
            acceptablePercent: acceptablePercent ? +acceptablePercent : null,
            ssimThreshold: SSIM_THRESHOLD,
            useButteraugli: USE_BUTTERAUGLI,
            butteraugliThreshold: USE_BUTTERAUGLI ? BUTTERAUGLI_THRESHOLD : null,
        });
    } finally {
        decoded.free();
    }
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outPath = join(OUT_DIR, `streaming-ssim-benchmark-${stamp}.json`);
writeFileSync(outPath, JSON.stringify({
    exportedAt: new Date().toISOString(),
    tier, target: TARGET, effort: EFFORT, quality: QUALITY,
    useButteraugli: USE_BUTTERAUGLI, butteraugliThreshold: USE_BUTTERAUGLI ? BUTTERAUGLI_THRESHOLD : null,
    results,
}, null, 2));
console.log(`\n[streaming-ssim] wrote ${outPath}`);

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

async function timedDecodeWithPixels(jxl, options) {
    const decoder = createDecoder(options);
    let finalMs = null, w = 0, h = 0, pixels = null;
    const tStart = performance.now();
    try {
        const evTask = (async () => {
            for await (const ev of decoder.events()) {
                if (ev.type === 'final') {
                    finalMs = performance.now() - tStart;
                    w = ev.info?.width > 0 ? ev.info.width : (ev.region?.w ?? 0);
                    h = ev.info?.height > 0 ? ev.info.height : (ev.region?.h ?? 0);
                    pixels = ev.pixels;
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
    return { finalMs: finalMs ?? performance.now() - tStart, w, h, pixels };
}

async function streamDecodeCutoffs(jxlBytes, plan, refPixels, refW, refH, options) {
    const cutoffs = [];

    // emitEveryPass: true enables JXL_DEC_FRAME_PROGRESSION subscription so the decoder
    // yields 'progress' events for each completed pass — critical for getting pixels from
    // truncated streams where 'final' never fires due to incomplete data.
    const decodeOpts = { ...options, emitEveryPass: true };

    for (const entry of plan) {
        const cutoff = { bytes: entry.bytes, percent: entry.percent, ssim: null, psnr: null, butteraugli: null, error: null };
        const decoder = createDecoder(decodeOpts);

        try {
            let finalPixels = null, finalW = 0, finalH = 0;
            let progressPixels = null, progressW = 0, progressH = 0;

            const eventTask = (async () => {
                for await (const event of decoder.events()) {
                    if (event.type === 'final') {
                        finalPixels = event.pixels ? new Uint8ClampedArray(event.pixels) : null;
                        finalW = event.info?.width > 0 ? event.info.width : 0;
                        finalH = event.info?.height > 0 ? event.info.height : 0;
                    } else if (event.type === 'progress') {
                        // Progressive pass completed — keep latest as fallback for truncated streams.
                        // pixels is already a .slice() copy (progressionTarget:'final' path in facade).
                        if (event.pixels && event.info?.width > 0 && event.info?.height > 0) {
                            progressPixels = new Uint8ClampedArray(event.pixels);
                            progressW = event.info.width;
                            progressH = event.info.height;
                        }
                    } else if (event.type === 'error') {
                        // Record but don't throw — progress pixels may already be captured.
                        cutoff.error = `${event.code}: ${event.message}`;
                    }
                }
            })();

            // Push only up to this cutoff point
            await decoder.push(exactBuffer(jxlBytes.subarray(0, entry.bytes)));
            await decoder.close();
            await eventTask;

            // Use final pixels if complete, otherwise fall back to last flushed progressive frame.
            const usePixels = finalPixels ?? progressPixels;
            const useW = finalW || progressW;
            const useH = finalH || progressH;

            if (usePixels && refPixels && useW > 0 && useH > 0 && useW === refW && useH === refH) {
                if (finalPixels) cutoff.error = null; // full decode succeeded — clear any stale error
                try {
                    const result = computeSsimPsnr(usePixels, refPixels, useW, useH);
                    cutoff.ssim = result.ssim;
                    cutoff.psnr = result.psnr;
                } catch (e) {
                    cutoff.error = e instanceof Error ? e.message : String(e);
                }
                if (USE_BUTTERAUGLI) {
                    try {
                        cutoff.butteraugli = await computeButteraugli(usePixels.buffer, refPixels.buffer, useW, useH);
                    } catch (e) {
                        cutoff.error = (cutoff.error ? cutoff.error + "; " : "") + `butteraugli: ${e instanceof Error ? e.message : String(e)}`;
                    }
                }
            }
        } catch (e) {
            cutoff.error = e instanceof Error ? e.message : String(e);
        } finally {
            try { await decoder.dispose(); } catch (_) {}
        }

        cutoffs.push(cutoff);
    }

    return cutoffs;
}

function computeSsimPsnr(pixels1, pixels2, width, height) {
    // ssim.js expects ImageData-like objects with data, width, height
    const img1 = { data: pixels1, width, height };
    const img2 = { data: pixels2, width, height };
    const ssimResult = SSIM.ssim(img1, img2);
    const ssimValue = ssimResult.mssim;

    // Compute PSNR (Peak Signal-to-Noise Ratio) - average RGB channels
    let mse = 0;
    const pixelCount = width * height;
    for (let i = 0; i < pixels1.length; i += 4) {
        const r1 = pixels1[i], g1 = pixels1[i+1], b1 = pixels1[i+2];
        const r2 = pixels2[i], g2 = pixels2[i+1], b2 = pixels2[i+2];
        const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
        mse += (dr * dr + dg * dg + db * db) / 3;
    }
    mse /= pixelCount;
    const psnr = mse === 0 ? Infinity : 10 * Math.log10(65025 / mse); // 255^2 = 65025

    return { ssim: ssimValue, psnr };
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

function waitForStreamEvents() {
    return new Promise((resolve) => setImmediate(resolve));
}
