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
//   { id, bytes: Uint8Array, options }
//   { id, type: 'reprocess_live', look }
//   { type: 'reprocess_thumb_live', taskIds: [], look }
//
// Worker posts (in order, transferring buffers where safe):
//   { id, type: 'thumb',         rgb, w, h, pipelineMs, phaseMs, wbR, wbB, ... }
//   { id, type: 'lightbox',      rgb, w, h }
//   { id, type: 'lightbox_live', rgb, w, h, liveMs }
//   { id, type: 'thumb_live',    rgb, w, h }  (one per taskId in batch)
//   { id, type: 'done',          jxl, jxlMs, w, h }
//   { id, type: 'error',         error }

import init, {
    process_orf,
    downscale_rgb,
    rgb_to_rgba,
    apply_look,
} from '../pkg/raw_converter_wasm.js';

import encode_jxl from './vendor/jsquash-jxl/encode.js';

const THUMB_LONG_EDGE = 360;
const LIGHTBOX_LONG_EDGE = 1800;

let wasmReady;
// Per-taskId state maps — survive across multiple files on this worker.
const liveStateMap  = new Map(); // taskId → {rgb16,w,h,outW,outH,orientation,wbR,wbB,colorMatrix}
const thumbStateMap = new Map(); // taskId → same shape but thumb-sized rgb16

async function ensureWasm() {
    if (!wasmReady) wasmReady = init();
    try {
        await wasmReady;
    } catch (err) {
        wasmReady = null; // allow retry on next call
        throw err;
    }
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

function makeLiveState(rgb16, w, h, orientation, wbR, wbB, colorMatrix) {
    const axisSwap = orientation >= 5 && orientation <= 8;
    return {
        rgb16,
        w, h,
        outW: axisSwap ? h : w,
        outH: axisSwap ? w : h,
        orientation, wbR, wbB, colorMatrix,
    };
}

function applyLookToState(state, look) {
    return apply_look(
        state.rgb16,
        state.w, state.h, state.orientation,
        state.wbR, state.wbB,
        state.colorMatrix,
        look.exposureEv  ?? 0, look.contrast   ?? 0,
        look.highlights  ?? 0, look.shadows    ?? 0,
        look.whites      ?? 0, look.blacks      ?? 0,
        look.saturation  ?? 0, look.vibrance    ?? 0,
        look.temp        ?? 0, look.tint        ?? 0,
        look.texture     ?? 0, look.clarity     ?? 0,
    );
}

self.addEventListener('message', async (ev) => {
    // --- lightbox live reprocess (single image) ---
    if (ev.data.type === 'reprocess_live') {
        const { id, look } = ev.data;
        const state = liveStateMap.get(id);
        if (!state) {
            self.postMessage({ id, type: 'error_live', error: 'no live state for this task' });
            return;
        }
        try {
            const t0 = performance.now();
            const rgb = applyLookToState(state, look);
            const liveMs = performance.now() - t0;
            self.postMessage(
                { id, type: 'lightbox_live', rgb, w: state.outW, h: state.outH, liveMs },
                [rgb.buffer],
            );
        } catch (err) {
            self.postMessage({ id, type: 'error_live', error: String(err?.message || err) });
        }
        return;
    }

    // --- gallery thumb batch reprocess (multiple taskIds owned by this worker) ---
    if (ev.data.type === 'reprocess_thumb_live') {
        const { taskIds, look } = ev.data;
        for (const tid of taskIds) {
            const state = thumbStateMap.get(tid);
            if (!state) continue;
            try {
                const rgb = applyLookToState(state, look);
                self.postMessage(
                    { id: tid, type: 'thumb_live', rgb, w: state.outW, h: state.outH },
                    [rgb.buffer],
                );
            } catch (err) {
                self.postMessage({ id: tid, type: 'error_live', error: String(err?.message || err) });
            }
        }
        return;
    }

    // --- full ORF pipeline ---
    const { id, bytes, options } = ev.data;
    if (!id || !bytes) {
        // Not a pipeline message — ignore unknown types silently
        return;
    }
    try {
        await ensureWasm();

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
        const ori = result.orientation;
        const colorMatrix = new Float32Array(result.color_matrix_used());

        // Flat EXIF blob for the lightbox info panel. Rationals are passed as
        // {n, d}; consumer formats. Zero denominators mean "absent".
        const exif = {
            make, model,
            lens: result.lens,
            datetime: result.datetime,
            exposure:   result.exposure_den   > 0 ? { n: result.exposure_num,   d: result.exposure_den   } : null,
            fnumber:    result.fnumber_den    > 0 ? { n: result.fnumber_num,    d: result.fnumber_den    } : null,
            focalLength: result.focal_length_den > 0 ? { n: result.focal_length_num, d: result.focal_length_den } : null,
            focalLength35: result.focal_length_35 || null,
            iso:        result.iso > 0 ? result.iso : null,
            orientation: ori,
            gps:        result.has_gps ? { lat: result.gps_lat, lon: result.gps_lon, alt: result.gps_alt } : null,
            quality:    result.quality || null,
            wbMode:     result.wb_mode === 0xFFFF ? null : result.wb_mode,
            wbR, wbB,
            wbFromCamera: result.wb_from_camera,
            width: w, height: h,
        };

        // Store lightbox liveState
        const lb16 = result.take_rgb16_lb();
        liveStateMap.set(id, makeLiveState(lb16, result.lb_w, result.lb_h, ori, wbR, wbB, colorMatrix));

        // Store thumb liveState
        const thumb16 = result.take_rgb16_thumb();
        thumbStateMap.set(id, makeLiveState(thumb16, result.thumb_w, result.thumb_h, ori, wbR, wbB, colorMatrix));

        // thumb RGB8 — send first for fast UI feedback
        const thumb = sized(w, h, THUMB_LONG_EDGE);
        const thumbRgb = downscale_rgb(fullRgb, w, h, thumb.w, thumb.h);
        self.postMessage(
            { id, type: 'thumb', rgb: thumbRgb, w: thumb.w, h: thumb.h, pipelineMs, phaseMs,
              wbR, wbB, make, model, colorMatrixFromMn, exif },
            [thumbRgb.buffer],
        );

        // lightbox RGB8
        const big = sized(w, h, LIGHTBOX_LONG_EDGE);
        const bigRgb = downscale_rgb(fullRgb, w, h, big.w, big.h);
        self.postMessage(
            { id, type: 'lightbox', rgb: bigRgb, w: big.w, h: big.h },
            [bigRgb.buffer],
        );

        // JXL encode (full-resolution) — convert to RGBA then drop fullRgb to allow GC
        const rgba = rgb_to_rgba(fullRgb);
        // fullRgb is no longer needed; allow GC before long JXL encode
        let fullRgbRef = fullRgb; fullRgbRef = null; // eslint-disable-line no-unused-vars
        const imageData = {
            data: new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength),
            width: w, height: h,
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
