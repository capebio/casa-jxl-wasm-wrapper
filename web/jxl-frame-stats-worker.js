import { analyzeProgressiveFrame } from './jxl-progressive-frame-stats.js';
import { computePsnrVsFinal, computeSsimVsFinal, computeChannelMoments } from './jxl-progressive-quality.js';
import { pixelsToXyb, computeButteraugliVsFinal, createButteraugliComparer, computeButteraugliApproxVsFinal } from './jxl-butteraugli.js';

// Optional wasm-accelerated metrics (PerceptualComparer in web/pkg). JS remains
// the fallback for no-WASM environments (CSP, locked-down webviews) or load
// failures. null = untried, false = unavailable, object = loaded module.
let _wasmMetrics = null;
async function ensureWasmMetrics() {
    if (_wasmMetrics !== null) return _wasmMetrics;
    try {
        const mod = await import('./pkg/raw_converter_wasm.js');
        await mod.default(); // browser worker: init() fetches _bg.wasm via module URL
        _wasmMetrics = (typeof mod.PerceptualComparer === 'function') ? mod : false;
    } catch {
        _wasmMetrics = false;
    }
    return _wasmMetrics;
}

// Stats offload (post-decode only). Lenses 1-25 applied at creation.
// Gaps (18/19): (1) no cancel/preempt for long butter (sync block); (2) pixel materialization at receive/xyb/return; (3) vs-final only, limited live/no-ref for AR/stream.
// Fast ML/AR gate (12/16): use includeButter=false + moments/psnr/ssim as surrogate; avoid butter cost.
// Perceptual (17): metrics here on decoded space; LookRenderer flat-log engine (Rust) is paint-time. Do not extend this layer until engine lands (see rejected P-1).
// Zero-copy (20/7/24): Layer1 applies pointer-move on owned buffers. Pointer > re-slice.
// SIMD (22/25): pixel loops not here; see imports + raw pipeline. Consider future WASM stats co-located with decode mem.
// Gaming/astro/photogram (13/11/14): job dispatch for perceptual "telescope"; fidelity for digital-twin recon.
// Run backwards (10): current final-ref = bench; live needs delta-between-passes.
// On flip-flop for changes: alternate via local const switch, 10 runs, compare emitted timings + external ms.

self.onmessage = (event) => {
    const { id, type } = event.data ?? {};
    if (type === 'chart') {
        handleChartRequest(id, event.data);
    } else {
        handleFrameStats(id, event.data);
    }
};

function handleFrameStats(id, data) {
    const { pixels, width, height, returnPixels = true } = data ?? {};
    try {
        const input = pixels instanceof Uint8Array ? pixels : new Uint8Array(pixels ?? new ArrayBuffer(0));
        const stats = analyzeProgressiveFrame(input, width, height);
        let pixField = undefined;
        const xfer = [];
        if (returnPixels) {
            const ab = input.buffer;
            const off = input.byteOffset;
            const len = input.byteLength;
            if (off === 0 && len === ab.byteLength) {
                pixField = ab;
                xfer.push(ab);
            } else {
                const output = ab.slice(off, off + len);
                pixField = output;
                xfer.push(output);
            }
        }
        self.postMessage({ id, ok: true, stats, pixels: pixField }, xfer);
    } catch (error) {
        self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
}

async function handleChartRequest(id, data) {
    const { ref, refWidth, refHeight, passes } = data;
    try {
        if (!passes || !passes.length) {
            self.postMessage({ id, ok: true, type: 'chart', values: [] });
            return;
        }
        const start = performance.now();
        const refPx = ref instanceof Uint8Array ? ref : new Uint8Array(ref);
        const n = refWidth * refHeight;

        // Prefer the wasm PerceptualComparer for the default (full butteraugli)
        // path: it computes psnr+ssim+butteraugli in one shared pass. The 'approx'
        // and includeButter===false paths stay on JS (different semantics). Falls
        // back to JS if wasm is unavailable or the comparer can't be built.
        const wm = (data.includeButter !== false && data.includeButter !== 'approx')
            ? await ensureWasmMetrics() : false;
        let wcmp = null;
        if (wm) {
            try {
                wcmp = new wm.PerceptualComparer(refPx, refWidth, refHeight);
            } catch {
                wcmp = null;
            }
        }

        let refXyb = null;
        let cmp = null;
        if (!wcmp && data.includeButter !== false) {
            if (data.includeButter === 'approx') {
                refXyb = pixelsToXyb(refPx, n);
            } else {
                cmp = createButteraugliComparer(refPx, refWidth, refHeight);
            }
        }
        const values = passes.map(p => {
            if (!p) return null;
            const px = p.buf instanceof Uint8Array ? p.buf : new Uint8Array(p.buf);
            if (wcmp) {
                const m = wcmp.all(px); // {butteraugli, ssim, psnr}
                return {
                    index: p.index,
                    psnr: m.psnr,
                    ssim: m.ssim,
                    butt: m.butteraugli,
                    moments: computeChannelMoments(px, refWidth, refHeight),
                };
            }
            const rec = {
                index: p.index,
                psnr: computePsnrVsFinal(refPx, px),
                ssim: computeSsimVsFinal(refPx, px, refWidth, refHeight),
                moments: computeChannelMoments(px, refWidth, refHeight),
            };
            if (data.includeButter !== false) {
                rec.butt = (data.includeButter === 'approx') ? computeButteraugliApproxVsFinal(refXyb, px, refWidth, refHeight) : cmp(px);
            } else {
                rec.butt = null;
            }
            return rec;
        });
        const end = performance.now();
        self.postMessage({ id, ok: true, type: 'chart', values, timings: { totalMs: end - start, passes: values.length, backend: wcmp ? 'wasm' : 'js' } });
    } catch (error) {
        self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
}
