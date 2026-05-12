// Per-file Web Worker.
//
// Owns its own wasm instance + its own jSquash encoder instance.  A pool of
// these runs in the main thread so N files convert concurrently across N
// CPU cores.  jSquash inside each worker stays single-threaded (we don't
// enable SharedArrayBuffer at the page level, so it auto-picks the
// non-threaded `jxl_enc.js` variant); file-level parallelism gives us the
// throughput.
//
// Protocol — main thread posts:
//   { id, name, bytes: Uint8Array, options: { quality, effort, lossless } }
//
// Worker posts (in order, transferring buffers where safe):
//   { id, type: 'thumb',    rgb: Uint8Array, w, h, pipelineMs, phaseMs }
//   { id, type: 'lightbox', rgb: Uint8Array, w, h }      // post-pipeline, mid-resolution
//   { id, type: 'done',     jxl: Uint8Array, jxlMs }
//   { id, type: 'error',    error: string }

import init, {
    process_orf,
    downscale_rgb,
    rgb_to_rgba,
} from '../pkg/raw_converter_wasm.js';

import encode_jxl from './vendor/jsquash-jxl/encode.js';

const THUMB_LONG_EDGE = 360;
const LIGHTBOX_LONG_EDGE = 1800;

let wasmReady;

async function ensureWasm() {
    if (!wasmReady) wasmReady = init();
    await wasmReady;
}

function sized(srcW, srcH, longEdge) {
    if (srcW >= srcH) {
        const w = Math.min(longEdge, srcW);
        return { w, h: Math.max(1, Math.round((srcH * w) / srcW)) };
    } else {
        const h = Math.min(longEdge, srcH);
        return { w: Math.max(1, Math.round((srcW * h) / srcH)), h };
    }
}

self.addEventListener('message', async (ev) => {
    const { id, bytes, options } = ev.data;
    try {
        await ensureWasm();

        // ---- ORF → RGB8 pipeline ------------------------------------------
        const pT0 = performance.now();
        const look = options.look || {};
        const result = process_orf(
            bytes,
            look.exposureEv ?? 0,
            look.contrast   ?? 0,
            look.highlights ?? 0,
            look.shadows    ?? 0,
            look.whites     ?? 0,
            look.blacks     ?? 0,
            look.saturation ?? 0,
            look.vibrance   ?? 0,
            look.temp       ?? 0,
            look.tint       ?? 0,
            Number.isFinite(options.wbR) ? options.wbR : NaN,
            Number.isFinite(options.wbB) ? options.wbB : NaN,
            look.texture ?? 0,
            look.clarity ?? 0,
        );
        const w = result.width;
        const h = result.height;
        const fullRgb = result.take_rgb();
        const pipelineMs = performance.now() - pT0;
        const phaseMs = {
            decompress: result.decompress_ms,
            demosaic:   result.demosaic_ms,
            tonemap:    result.tonemap_ms,
            orient:     result.orient_ms,
        };
        const wbR = result.wb_r_used;
        const wbB = result.wb_b_used;
        const make  = result.make;
        const model = result.model;
        const colorMatrixFromMn = result.color_matrix_from_mn;

        // ---- thumbnail (small) — send first so UI updates fast ------------
        const thumb = sized(w, h, THUMB_LONG_EDGE);
        const thumbRgb = downscale_rgb(fullRgb, w, h, thumb.w, thumb.h);
        self.postMessage(
            { id, type: 'thumb', rgb: thumbRgb, w: thumb.w, h: thumb.h, pipelineMs, phaseMs,
              wbR, wbB, make, model, colorMatrixFromMn },
            [thumbRgb.buffer],
        );

        // ---- lightbox-sized preview ---------------------------------------
        const big = sized(w, h, LIGHTBOX_LONG_EDGE);
        const bigRgb = downscale_rgb(fullRgb, w, h, big.w, big.h);
        self.postMessage(
            { id, type: 'lightbox', rgb: bigRgb, w: big.w, h: big.h },
            [bigRgb.buffer],
        );

        // ---- JXL encode (full-resolution) ---------------------------------
        const rgba = rgb_to_rgba(fullRgb);
        const imageData = {
            data: new Uint8ClampedArray(rgba),
            width: w,
            height: h,
        };
        const jT0 = performance.now();
        const jxlAB = await encode_jxl(imageData, {
            quality: options.lossless ? 100 : options.quality,
            effort: options.effort,
            lossless: !!options.lossless,
        });
        const jxlMs = performance.now() - jT0;

        const jxlBytes = new Uint8Array(jxlAB);
        self.postMessage(
            { id, type: 'done', jxl: jxlBytes, jxlMs, w, h },
            [jxlBytes.buffer],
        );
    } catch (err) {
        self.postMessage({
            id,
            type: 'error',
            error: (err && (err.message || String(err))) || 'unknown error',
        });
    }
});
