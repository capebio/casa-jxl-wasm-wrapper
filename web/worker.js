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

import init, * as rawWasm from './pkg/raw_converter_wasm.js';
// A3: rgb_to_rgba removed — send RGB8 directly to JXL worker (saves ~250ms + 25% transfer)
const { process_orf, process_orf_with_flags, process_cr2_with_flags, process_dng_with_flags, LookRenderer, rotate_rgb8 } = rawWasm;

// Route a RAW buffer to the right decoder by magic bytes (robust vs. filename):
//   Olympus ORF: 'IIR' (IIRO/IIRS/IIUS).  Canon CR2: TIFF 'II*\0' with 'CR' at offset 8.
//   Everything else TIFF-like (II*\0 / MM\0*) → DNG. Falls back to ORF if unrecognized.
function pickRawDecoderWithFlags(bytes) {
  const b = bytes;
  if (b.length >= 10) {
    if (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x52) return process_orf_with_flags; // IIR*
    if (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00 &&
        b[8] === 0x43 && b[9] === 0x52) return process_cr2_with_flags;                  // II*\0 + 'CR'
    if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) ||
        (b[0] === 0x4d && b[1] === 0x4d && b[3] === 0x2a)) return process_dng_with_flags; // TIFF → DNG
  }
  return process_orf_with_flags;
}

// EXIF orientation flag bits (mirror src/lib.rs).
const OUT_FULL_RGB8 = 1;
const OUT_LIGHTBOX  = 2;
const OUT_THUMB     = 4;
const OUT_NO_ORIENT = 8;

// Compose EXIF orientation tag (1..8) with N additional CW quarter-turns.
// Only handles the cycle {1, 6, 3, 8} that maps to pure rotations — Olympus
// ORFs never produce 2/4/5/7 (mirror variants). Returns the original tag
// unchanged for those edge cases (caller still gets a correct image since
// JXL will record the mirror; userTurns just doesn't compose with mirrors).
function composeOrientation(exifOri, cwTurns) {
    const cycle = [1, 6, 3, 8];          // 0°, 90° CW, 180°, 270° CW
    const idx = cycle.indexOf(exifOri);
    if (idx < 0) return exifOri;          // mirror variants — pass through
    return cycle[(idx + (cwTurns & 3)) & 3];
}

// JXL encoding is handled by jxl-worker.js (spawned from the main thread).

let wasmReady;
// Per-taskId state maps — survive across multiple files on this worker.
const liveStateMap  = new Map(); // taskId → {renderer: LookRenderer, outW, outH, wbR, wbB}
const thumbStateMap = new Map(); // taskId → same shape but thumb-sized LookRenderer

async function ensureWasm() {
    if (!wasmReady) wasmReady = (async () => {
        await init();
        // A2: init rayon thread pool when parallel-wasm feature is compiled in.
        // Guard: shared memory requires crossOriginIsolated (COOP/COEP). Falls
        // back silently to single-threaded WASM if the context is not isolated
        // or the browser rejects the memory transfer (e.g. nested worker COI gap).
        if (typeof rawWasm.initThreadPool === 'function') {
            if (self.__disableThreadPool) {
                console.log('[worker] thread pool disabled (test mode)');
            } else if (crossOriginIsolated) {
                try {
                    await rawWasm.initThreadPool(navigator.hardwareConcurrency);
                } catch (e) {
                    console.warn('[worker] rayon thread pool init failed, using single-thread WASM:', e.message);
                }
            } else {
                console.warn('[worker] crossOriginIsolated=false — skipping rayon thread pool');
            }
        }
    })();
    try {
        await wasmReady;
    } catch (err) {
        wasmReady = null;
        throw err;
    }
}

// makeLiveState constructs a LookRenderer (WASM-resident) from packed rgb16 bytes.
// The renderer owns the RGB16 buffer inside WASM; subsequent render() calls
// transfer only the output RGB8, not the cached buffer.
//
// Phase 2: construct with apply_rotation=false. render() returns sensor-orient
// pixels with sensor dims. Main thread applies EXIF rotation as a canvas
// transform during draw — GPU-accelerated, decoupled from slider tick rate.
function makeLiveState(rgb16Bytes, w, h, orientation, wbR, wbB, colorMatrix) {
    // Only orientations 6 (90° CW) and 8 (90° CCW) actually swap axes in
    // apply_orientation (pipeline.rs).  Tags 5/7 are pass-through there, so
    // using orientation >= 5 overreports axisSwap and mis-sizes the canvas.
    const axisSwap = orientation === 6 || orientation === 8;
    const renderer = LookRenderer.new_with_options(rgb16Bytes, w, h, orientation, colorMatrix, false);
    return {
        renderer,
        // Native source dims (sensor orientation).
        nativeW: w,
        nativeH: h,
        // Display dims after rotation (what the canvas should be sized to).
        outW: axisSwap ? h : w,
        outH: axisSwap ? w : h,
        orientation,
        wbR, wbB,
    };
}

function applyLookToState(state, look) {
    return state.renderer.render(
        state.wbR, state.wbB,
        look.exposureEv  ?? 0, look.contrast   ?? 0,
        look.highlights  ?? 0, look.shadows    ?? 0,
        look.whites      ?? 0, look.blacks      ?? 0,
        look.saturation  ?? 0, look.vibrance    ?? 0,
        look.temp        ?? 0, look.tint        ?? 0,
        look.texture     ?? 0, look.clarity     ?? 0,
    );
}

self.addEventListener('message', async (ev) => {
    // --- release cached LookRenderer state for a re-submitted task ---
    if (ev.data.type === 'release_state') {
        const lbState = liveStateMap.get(ev.data.id);
        if (lbState) { lbState.renderer.free(); liveStateMap.delete(ev.data.id); }
        const tState = thumbStateMap.get(ev.data.id);
        if (tState) { tState.renderer.free(); thumbStateMap.delete(ev.data.id); }
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
                { id, type: 'lightbox_live', rgb,
                  // Phase 2: rgb is in sensor orientation (nativeW × nativeH).
                  // Display canvas is sized outW × outH. Main thread rotates via canvas transform.
                  w: state.outW, h: state.outH,
                  nativeW: state.nativeW, nativeH: state.nativeH,
                  orientation: state.orientation,
                  liveMs },
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
                    { id: tid, type: 'thumb_live', rgb,
                      w: state.outW, h: state.outH,
                      nativeW: state.nativeW, nativeH: state.nativeH,
                      orientation: state.orientation },
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
        // OUT_NO_ORIENT: skip apply_orientation on the full RGB8 — JXL records
        // rotation as metadata, so pixels stay sensor-native and we avoid the
        // 60–200 MB intermediate buffer + cache-hostile transpose at encode prep.
        const fullPipeFlags = OUT_FULL_RGB8 | OUT_LIGHTBOX | OUT_THUMB | OUT_NO_ORIENT;
        const result = pickRawDecoderWithFlags(bytes)(
            bytes,
            fullPipeFlags,
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
        // OUT_NO_ORIENT: result.width/height are sensor dims (pre-rotation).
        let w = result.width;
        let h = result.height;
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
        // Phase 2: rgb is sensor-orient; main thread rotates via canvas transform.
        const thumbState = thumbStateMap.get(id);
        const thumbRgb = applyLookToState(thumbState, look);
        self.postMessage(
            { id, type: 'thumb', rgb: thumbRgb,
              w: thumbState.outW, h: thumbState.outH,
              nativeW: thumbState.nativeW, nativeH: thumbState.nativeH,
              orientation: thumbState.orientation,
              pipelineMs, phaseMs, wbR, wbB, make, model, colorMatrixFromMn, exif },
            [thumbRgb.buffer],
        );

        // lightbox RGB8 — same: apply look to the pre-scaled rgb16 (1800px) in liveStateMap.
        const lbState = liveStateMap.get(id);
        const bigRgb = applyLookToState(lbState, look);
        self.postMessage(
            { id, type: 'lightbox', rgb: bigRgb,
              w: lbState.outW, h: lbState.outH,
              nativeW: lbState.nativeW, nativeH: lbState.nativeH,
              orientation: lbState.orientation },
            [bigRgb.buffer],
        );

        // JXL records orientation as metadata — no pixel rotation needed for the
        // EXIF tag. User rotation (90° turns from the UI) composes into the
        // same tag, so userTurns also never triggers a CPU rotate.
        const userTurns = Math.round(((options.userRotation || 0) % 360 + 360) % 360 / 90) % 4;
        const encodeOrientation = composeOrientation(ori, userTurns);
        let fullRgb = result.take_rgb();

        // A3: send RGB8 directly — skip the ~210ms rgb_to_rgba conversion and 25% larger transfer.
        const rgbBuf = fullRgb.buffer.slice(fullRgb.byteOffset, fullRgb.byteOffset + fullRgb.byteLength);
        fullRgb = null; // allow GC
        self.postMessage(
            { id, type: 'encode_request', pixels: rgbBuf, format: 'rgb8', width: w, height: h,
              quality: options.lossless ? 100 : options.quality,
              effort: options.effort ?? 3,
              lossless: !!options.lossless,
              orientation: encodeOrientation },
            [rgbBuf],
        );
    } catch (err) {
        // Free any LookRenderer objects stored before the failure so WASM memory
        // is not leaked for tasks that will never re-render.
        if (id !== undefined) {
            const lbState = liveStateMap.get(id);
            if (lbState) { lbState.renderer.free(); }
            liveStateMap.delete(id);
            const tState = thumbStateMap.get(id);
            if (tState) { tState.renderer.free(); }
            thumbStateMap.delete(id);
        }
        self.postMessage({
            id,
            type: 'error',
            error: (err && (err.message || String(err))) || 'unknown error',
        });
    }
});
