// Per-file Web Worker.
//
// Owns its own wasm instance.  A pool of these runs in the main thread so N
// files convert concurrently across N CPU cores.  JXL encoding is offloaded
// to a separate pool of jxl-worker.js instances (SIMD+MT, spawned from the
// main thread so Emscripten Pthreads bootstrap correctly under COOP/COEP).
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
    rgb_to_rgba,
    apply_look,
    rotate_rgb8,
} from '../pkg/raw_converter_wasm.js';

// JXL encoding is handled by jxl-worker.js (spawned from the main thread).

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

function makeLiveState(rgb16, w, h, orientation, wbR, wbB, colorMatrix) {
    // Only orientations 6 (90° CW) and 8 (90° CCW) actually swap axes in
    // apply_orientation (pipeline.rs).  Tags 5/7 are pass-through there, so
    // using orientation >= 5 overreports axisSwap and mis-sizes the canvas.
    const axisSwap = orientation === 6 || orientation === 8;
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
    // --- release cached rgb16 state for a re-submitted task ---
    if (ev.data.type === 'release_state') {
        liveStateMap.delete(ev.data.id);
        thumbStateMap.delete(ev.data.id);
        return;
    }

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
        let w = result.width;
        let h = result.height;
        let fullRgb = result.take_rgb();
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

        // thumb RGB8 — apply look to the pre-scaled rgb16 (360px) already cached in thumbStateMap.
        // Avoids downscaling the full 20MP fullRgb (~200× more pixels) for the same result.
        const thumbState = thumbStateMap.get(id);
        const thumbRgb = applyLookToState(thumbState, look);
        self.postMessage(
            { id, type: 'thumb', rgb: thumbRgb, w: thumbState.outW, h: thumbState.outH,
              pipelineMs, phaseMs, wbR, wbB, make, model, colorMatrixFromMn, exif },
            [thumbRgb.buffer],
        );

        // lightbox RGB8 — same: apply look to the pre-scaled rgb16 (1800px) in liveStateMap.
        const lbState = liveStateMap.get(id);
        const bigRgb = applyLookToState(lbState, look);
        self.postMessage(
            { id, type: 'lightbox', rgb: bigRgb, w: lbState.outW, h: lbState.outH },
            [bigRgb.buffer],
        );

        // Bake user rotation into JXL pixels — display rotation is CSS-side in main thread
        const userTurns = Math.round(((options.userRotation || 0) % 360 + 360) % 360 / 90) % 4;
        if (userTurns !== 0) {
            const rotRes = rotate_rgb8(fullRgb, w, h, userTurns);
            fullRgb = rotRes.take_rgb();
            w = rotRes.width;
            h = rotRes.height;
            rotRes.free();
        }

        // Hand off full-res RGBA to the dedicated JXL encode worker (main.js
        // spawns it from the page thread so Emscripten Pthreads work under COOP/COEP).
        const rgba = rgb_to_rgba(fullRgb);
        fullRgb = null; // allow GC
        // Slice to a zero-offset owned buffer before transfer (rgba is a WASM heap view).
        const rgbaBuf = rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength);
        self.postMessage(
            { id, type: 'encode_request', rgba: rgbaBuf, width: w, height: h,
              quality: options.lossless ? 100 : options.quality,
              effort: options.effort ?? 3,
              lossless: !!options.lossless },
            [rgbaBuf],
        );
    } catch (err) {
        // Clean up any rgb16 state stored before the failure so the worker
        // doesn't hold large buffers for tasks that will never re-render.
        if (id !== undefined) {
            liveStateMap.delete(id);
            thumbStateMap.delete(id);
        }
        self.postMessage({
            id,
            type: 'error',
            error: (err && (err.message || String(err))) || 'unknown error',
        });
    }
});
