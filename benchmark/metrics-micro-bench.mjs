// Micro-benchmark + parity check for chart quality metrics (PSNR/SSIM/Butteraugli).
// Compares the repo versions in web/ against a baseline snapshot directory.
//
// Usage:
//   node benchmark/metrics-micro-bench.mjs [baselineDir]
//
// baselineDir defaults to %TEMP%/metric-baseline (copies of jxl-butteraugli.js and
// jxl-progressive-quality.js taken before an optimization). If the directory is
// missing, runs the repo versions alone (timing only, no parity).
//
// Synthetic deterministic workload: ~1MP RGBA reference + 4 "passes" with
// decreasing noise — mirrors the jxl-frame-stats-worker chart request shape
// (one reference, many passes, CHART_MAX_PIXELS = 1MP cap).

import { pathToFileURL } from 'url';
import { join } from 'path';
import os from 'os';

const W = 1280, H = 800; // 1.024 MP — matches browser chart cap order of magnitude
const N = W * H;
const PASS_NOISE = [24, 12, 5, 0]; // per-pass max channel noise; last pass identical to ref

// xorshift32 — deterministic across runs/engines
function makeRng(seed) {
    let s = seed >>> 0 || 1;
    return () => {
        s ^= s << 13; s >>>= 0;
        s ^= s >> 17;
        s ^= s << 5; s >>>= 0;
        return s / 0xffffffff;
    };
}

function makeImage() {
    const rng = makeRng(0xC0FFEE);
    const px = new Uint8Array(N * 4);
    for (let i = 0, j = 0; i < N; i++, j += 4) {
        const x = i % W, y = (i / W) | 0;
        // Smooth gradients + structured texture so masking/blur paths do real work
        px[j]     = (x * 255 / W + 40 * Math.sin(y / 17) + rng() * 8) & 255;
        px[j + 1] = (y * 255 / H + 40 * Math.sin(x / 23) + rng() * 8) & 255;
        px[j + 2] = ((x + y) * 127 / (W + H) + 30 * Math.sin((x + 2 * y) / 31)) & 255;
        px[j + 3] = 255;
    }
    return px;
}

function makePasses(ref) {
    const passes = [];
    for (const amp of PASS_NOISE) {
        const rng = makeRng(0xBADF00D ^ amp);
        const p = new Uint8Array(ref);
        if (amp > 0) {
            for (let j = 0; j < p.length; j += 4) {
                p[j]     = Math.max(0, Math.min(255, p[j]     + (rng() - 0.5) * 2 * amp)) | 0;
                p[j + 1] = Math.max(0, Math.min(255, p[j + 1] + (rng() - 0.5) * 2 * amp)) | 0;
                p[j + 2] = Math.max(0, Math.min(255, p[j + 2] + (rng() - 0.5) * 2 * amp)) | 0;
            }
        }
        passes.push(p);
    }
    return passes;
}

async function loadImpl(label, buttPath, qualPath) {
    try {
        const butt = await import(pathToFileURL(buttPath).href);
        const qual = await import(pathToFileURL(qualPath).href);
        return { label, ...butt, ...qual };
    } catch (e) {
        console.warn(`[${label}] not loadable (${e.message}) — skipped`);
        return null;
    }
}

function runSuite(impl, ref, passes) {
    const scores = { psnr: [], ssim: [], butt: [] };
    const times = { psnr: 0, ssim: 0, butt: 0, xyb: 0 };

    let t0 = performance.now();
    const refXyb = impl.pixelsToXyb(ref, N);
    times.xyb = performance.now() - t0;

    for (const p of passes) {
        t0 = performance.now();
        scores.psnr.push(impl.computePsnrVsFinal(ref, p));
        times.psnr += performance.now() - t0;

        t0 = performance.now();
        scores.ssim.push(impl.computeSsimVsFinal(ref, p, W, H));
        times.ssim += performance.now() - t0;

        t0 = performance.now();
        scores.butt.push(impl.computeButteraugliVsFinal(refXyb, p, W, H));
        times.butt += performance.now() - t0;
    }
    return { scores, times };
}

function fmtRow(label, t) {
    const total = t.xyb + t.psnr + t.ssim + t.butt;
    return `${label.padEnd(10)} xyb ${t.xyb.toFixed(1).padStart(7)} ms | psnr ${t.psnr.toFixed(1).padStart(7)} ms | ssim ${t.ssim.toFixed(1).padStart(7)} ms | butt ${t.butt.toFixed(1).padStart(7)} ms | total ${total.toFixed(1).padStart(7)} ms`;
}

function relDiff(a, b) {
    if (a === b) return 0; // covers Infinity === Infinity
    const denom = Math.max(Math.abs(a), Math.abs(b), 1e-12);
    return Math.abs(a - b) / denom;
}

async function main() {
    const baselineDir = process.argv[2] ?? join(os.tmpdir(), 'metric-baseline');
    const repoDir = new URL('../web/', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');

    const current = await loadImpl('current', join(repoDir, 'jxl-butteraugli.js'), join(repoDir, 'jxl-progressive-quality.js'));
    const baseline = await loadImpl('baseline', join(baselineDir, 'jxl-butteraugli.js'), join(baselineDir, 'jxl-progressive-quality.js'));
    if (!current) throw new Error('repo metric modules failed to load');

    const ref = makeImage();
    const passes = makePasses(ref);
    console.log(`Workload: ${W}x${H} (${(N / 1e6).toFixed(2)} MP), ${passes.length} passes, noise ${PASS_NOISE.join('/')}\n`);

    // Warmup then measure (median of 3)
    const measure = (impl) => {
        runSuite(impl, ref, passes); // warmup / JIT
        const runs = [];
        for (let i = 0; i < 3; i++) runs.push(runSuite(impl, ref, passes));
        runs.sort((a, b) =>
            (a.times.xyb + a.times.psnr + a.times.ssim + a.times.butt) -
            (b.times.xyb + b.times.psnr + b.times.ssim + b.times.butt));
        return runs[1];
    };

    const cur = measure(current);
    console.log(fmtRow('current', cur.times));

    if (baseline) {
        const base = measure(baseline);
        console.log(fmtRow('baseline', base.times));

        const speedup = (k) => (base.times[k] / Math.max(cur.times[k], 0.001)).toFixed(2);
        console.log(`\nSpeedup: xyb ${speedup('xyb')}x | psnr ${speedup('psnr')}x | ssim ${speedup('ssim')}x | butt ${speedup('butt')}x`);

        let worst = 0, failures = 0;
        for (const k of ['psnr', 'ssim', 'butt']) {
            base.scores[k].forEach((bv, i) => {
                const d = relDiff(bv, cur.scores[k][i]);
                worst = Math.max(worst, d);
                if (d > 1e-3) {
                    failures++;
                    console.error(`PARITY FAIL ${k}[${i}]: baseline=${bv} current=${cur.scores[k][i]} relDiff=${d}`);
                }
            });
        }
        console.log(`Parity: worst relative diff ${worst.toExponential(2)} (tolerance 1e-3) — ${failures === 0 ? 'PASS' : `${failures} FAILURES`}`);
        if (failures > 0) process.exitCode = 1;
    }

    console.log(`\nScores (current): butt=${cur.scores.butt.map(v => v.toFixed(4)).join(', ')} | ssim=${cur.scores.ssim.map(v => v.toFixed(5)).join(', ')} | psnr=${cur.scores.psnr.map(v => Number.isFinite(v) ? v.toFixed(2) : 'Inf').join(', ')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
