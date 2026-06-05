/**
 * P3.1 feature benchmark: previewFirst, region/downsample, JXTC extraction.
 *
 * Usage:
 *   node benchmark/p3-features-benchmark.mjs
 *   P3_LIMIT=3 node benchmark/p3-features-benchmark.mjs
 *
 * Reads JPEGs from the Gobabeb JPEG folder, encodes progressive JXL, then times:
 *   1. JXTC extraction (pure JS SOI/EOI scan)
 *   2. previewFirst: DC-only downsample=2 decode vs first progressive frame
 *   3. Region/downsample decode speedup vs full decode
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { performance } from "node:perf_hooks";

if (typeof globalThis.Worker === "undefined" && !process.env.JXL_WASM_FORCE_TIER) {
    process.env.JXL_WASM_FORCE_TIER = "simd";
}

const { createDecoder, detectTier, transcodeJpegToJxl } =
    await import("../packages/jxl-wasm/dist/index.js");

// Pure JS SOI/EOI scan — mirrors extractEmbeddedJpegs() in jxl-decode-worker.js.
// dist/index.js does not yet export extractJpegReconstructionFromJxl (built before it was added).
function extractJpegFromJxlBytes(bytes) {
    const sois = [];
    for (let i = 0; i < bytes.length - 2; i++) {
        if (bytes[i] === 0xFF && bytes[i + 1] === 0xD8 && bytes[i + 2] === 0xFF) { sois.push(i); i += 2; }
    }
    for (let n = 0; n < sois.length; n++) {
        const start = sois[n];
        const end = n + 1 < sois.length ? sois[n + 1] : bytes.length;
        for (let j = end - 2; j >= start + 2; j--) {
            if (bytes[j] === 0xFF && bytes[j + 1] === 0xD9) return bytes.slice(start, j + 2);
        }
    }
    return null;
}

const JPEG_DIR = String.raw`C:\995\2026-02-20 Gobabeb To Windhoek\JPEG`;
const OUT_DIR = String.raw`C:\Foo\raw-converter-wasm\docs\Benchmark results`;
const LIMIT = Math.max(1, Number(process.env.P3_LIMIT ?? "3"));

const tier = detectTier();
console.log(`[p3-bench] tier=${tier} limit=${LIMIT}`);

const files = readdirSync(JPEG_DIR, { withFileTypes: true })
    .filter(e => e.isFile() && extname(e.name).toLowerCase() === ".jpg")
    .map(e => ({ name: e.name, path: join(JPEG_DIR, e.name), size: statSync(join(JPEG_DIR, e.name)).size }))
    .sort((a, b) => b.size - a.size)
    .slice(0, LIMIT);

if (!files.length) throw new Error(`No JPEGs in ${JPEG_DIR}`);
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const results = [];

for (const file of files) {
    console.log(`\n[p3-bench] ${file.name} (${(file.size / 1024).toFixed(0)} KB)`);
    const jpegBytes = new Uint8Array(readFileSync(file.path));

    // --- Test 1: JXTC extraction ---
    const t0 = performance.now();
    let jxtcJxl = null;
    let jxtcMs = null;
    let extractedJpegBytes = null;
    let extractMs = null;
    let jxtcAvailable = false;

    try {
        jxtcJxl = await transcodeJpegToJxl(jpegBytes.buffer);
        jxtcMs = performance.now() - t0;

        const te = performance.now();
        extractedJpegBytes = extractJpegFromJxlBytes(jxtcJxl);
        extractMs = performance.now() - te;

        jxtcAvailable = extractedJpegBytes !== null;
        console.log(`  jxtc: transcode=${jxtcMs.toFixed(1)}ms  extract=${extractMs.toFixed(2)}ms  recovered=${extractedJpegBytes ? (extractedJpegBytes.byteLength / 1024).toFixed(0) + "KB" : "null"}`);
    } catch (e) {
        console.warn(`  jxtc: skipped (${e.message})`);
    }

    // Encode progressive JXL from raw JPEG pixels via decoder path:
    // Use the JXTC JXL (or encode via jpegTranscode approach) for decode tests.
    // If JXTC not available, skip decode tests.
    const jxlForDecode = jxtcJxl;
    if (!jxlForDecode) {
        results.push({ file: file.name, jpegsizeKb: file.size / 1024, jxtcAvailable: false });
        continue;
    }

    // --- Test 2: previewFirst vs normal progressive first-frame ---
    // Path A: full decode, time to first progress event
    const pathA = await timeToFirstFrame(jxlForDecode, {
        format: 'rgba8',
        progressionTarget: 'final',
        emitEveryPass: true,
        progressiveDetail: 'dc',
        downsample: 1,
        preserveIcc: false,
        preserveMetadata: false,
    });
    console.log(`  full-decode: firstFrameMs=${pathA.firstFrameMs.toFixed(1)}ms  finalMs=${pathA.finalMs.toFixed(1)}ms  passes=${pathA.passCount}  w=${pathA.w} h=${pathA.h}`);

    // Path B: DC-only decode at downsample=2 (simulates previewFirst path)
    const pathB = await timeToFirstFrame(jxlForDecode, {
        format: 'rgba8',
        progressionTarget: 'final',
        emitEveryPass: false,
        progressiveDetail: 'dc',
        downsample: 2,
        preserveIcc: false,
        preserveMetadata: false,
    });
    console.log(`  preview-dc-ds2: firstFrameMs=${pathB.firstFrameMs.toFixed(1)}ms  finalMs=${pathB.finalMs.toFixed(1)}ms  w=${pathB.w} h=${pathB.h}`);

    const previewSpeedup = pathA.firstFrameMs > 0 ? (pathA.firstFrameMs / pathB.finalMs).toFixed(2) : "n/a";
    console.log(`  → previewFirst speedup to first low-res pixels: ${previewSpeedup}x`);

    // --- Test 3: region/downsample vs full ---
    // Full decode (already done: pathA.finalMs)
    const fullMs = pathA.finalMs;

    // Downsample=2 full image
    const ds2 = await timeToFirstFrame(jxlForDecode, {
        format: 'rgba8',
        progressionTarget: 'final',
        emitEveryPass: false,
        progressiveDetail: 'dc',
        downsample: 2,
        preserveIcc: false,
        preserveMetadata: false,
    });
    const ds2Speedup = fullMs > 0 ? (fullMs / ds2.finalMs).toFixed(2) : "n/a";
    console.log(`  ds2-full: finalMs=${ds2.finalMs.toFixed(1)}ms  speedup=${ds2Speedup}x`);

    // Region: center 50% crop — Region = { x, y, w, h } (origin + size)
    const rW = pathA.w;
    const rH = pathA.h;
    const region = {
        x: Math.floor(rW * 0.25),
        y: Math.floor(rH * 0.25),
        w: Math.floor(rW * 0.5),
        h: Math.floor(rH * 0.5),
    };
    const regionDecode = await timeToFirstFrame(jxlForDecode, {
        format: 'rgba8',
        progressionTarget: 'final',
        emitEveryPass: false,
        progressiveDetail: 'dc',
        downsample: 1,
        region,
        preserveIcc: false,
        preserveMetadata: false,
    });
    const regionSpeedup = fullMs > 0 ? (fullMs / regionDecode.finalMs).toFixed(2) : "n/a";
    console.log(`  region-center50pct: finalMs=${regionDecode.finalMs.toFixed(1)}ms  speedup=${regionSpeedup}x  w=${regionDecode.w} h=${regionDecode.h}`);

    // Region + downsample=2
    const regionDs2 = await timeToFirstFrame(jxlForDecode, {
        format: 'rgba8',
        progressionTarget: 'final',
        emitEveryPass: false,
        progressiveDetail: 'dc',
        downsample: 2,
        region,
        preserveIcc: false,
        preserveMetadata: false,
    });
    const regionDs2Speedup = fullMs > 0 ? (fullMs / regionDs2.finalMs).toFixed(2) : "n/a";
    console.log(`  region+ds2: finalMs=${regionDs2.finalMs.toFixed(1)}ms  speedup=${regionDs2Speedup}x  w=${regionDs2.w} h=${regionDs2.h}`);

    results.push({
        file: file.name,
        jpegsizeKb: Math.round(file.size / 1024),
        jxlBytes: jxlForDecode.byteLength,
        jxtcAvailable,
        jxtcTranscodeMs: jxtcMs,
        jxtcExtractMs: extractMs,
        fullDecode: { firstFrameMs: pathA.firstFrameMs, finalMs: pathA.finalMs, passes: pathA.passCount, w: pathA.w, h: pathA.h },
        previewDcDs2: { finalMs: pathB.finalMs, w: pathB.w, h: pathB.h, speedupVsFullFirstFrame: Number(previewSpeedup) || null },
        ds2Full: { finalMs: ds2.finalMs, speedup: Number(ds2Speedup) || null },
        regionCenter50: { finalMs: regionDecode.finalMs, speedup: Number(regionSpeedup) || null, w: regionDecode.w, h: regionDecode.h },
        regionDs2: { finalMs: regionDs2.finalMs, speedup: Number(regionDs2Speedup) || null, w: regionDs2.w, h: regionDs2.h },
    });
}

// Summary
console.log("\n=== SUMMARY ===");
for (const r of results) {
    if (!r.jxtcAvailable) { console.log(`${r.file}: jxtc unavailable`); continue; }
    console.log(`${r.file}:`);
    console.log(`  JXTC extract: ${r.jxtcExtractMs?.toFixed(2)}ms (trivial JS scan)`);
    console.log(`  previewFirst benefit: ${r.previewDcDs2?.speedupVsFullFirstFrame}x faster to low-res pixels`);
    console.log(`  downsample=2 benefit: ${r.ds2Full?.speedup}x`);
    console.log(`  region center50: ${r.regionCenter50?.speedup}x  region+ds2: ${r.regionDs2?.speedup}x`);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outPath = join(OUT_DIR, `p3-features-benchmark-${stamp}.json`);
writeFileSync(outPath, JSON.stringify({ exportedAt: new Date().toISOString(), tier, results }, null, 2));
console.log(`\n[p3-bench] wrote ${outPath}`);

// --- helpers ---

async function timeToFirstFrame(jxl, options) {
    const decoder = createDecoder(options);
    let firstFrameMs = null;
    let finalMs = null;
    let passCount = 0;
    let w = 0, h = 0;
    const tStart = performance.now();

    try {
        const eventTask = (async () => {
            for await (const ev of decoder.events()) {
                if (ev.type === 'progress' || ev.type === 'final') {
                    passCount++;
                    if (firstFrameMs === null) firstFrameMs = performance.now() - tStart;
                    if (ev.type === 'final') {
                        finalMs = performance.now() - tStart;
                        w = (ev.info?.width > 0 ? ev.info.width : null) ?? (ev.region?.w ?? 0);
                        h = (ev.info?.height > 0 ? ev.info.height : null) ?? (ev.region?.h ?? 0);
                    }
                } else if (ev.type === 'error') {
                    throw new Error(`${ev.code}: ${ev.message}`);
                }
            }
        })();

        await decoder.push(jxl instanceof Uint8Array ? jxl.buffer : jxl);
        await decoder.close();
        await eventTask;
    } finally {
        try { await decoder.dispose(); } catch (_) {}
    }

    return {
        firstFrameMs: firstFrameMs ?? (performance.now() - tStart),
        finalMs: finalMs ?? (performance.now() - tStart),
        passCount,
        w,
        h,
    };
}
