// Dedicated JXL encode worker.  Must be spawned from the page's main thread
// (not from within another worker) so that Emscripten Pthreads can bootstrap
// correctly under COOP + COEP headers.
//
// Protocol:
//   main → worker: { id, type:'encode_request', rgba: ArrayBuffer, width, height,
//                    quality, effort, lossless }
//   worker → main: { id, type:'done',         jxl: Uint8Array, jxlMs, w, h,
//                    effortUsed, effortRequested }
//               or { id, type:'encode_error',  error: string }
//
// At effort 7 on large images the libjxl WASM heap runs out.  When that
// happens the module becomes permanently unusable (ABORT flag is set).
// The worker re-inits a fresh module instance and retries at effort-1, cascading
// down until effort 5, then reports effortUsed < effortRequested so the UI can warn.

import { initEmscriptenModule } from './vendor/jsquash-jxl/utils.js';
import { defaultOptions }        from './vendor/jsquash-jxl/meta.js';
import jxlMtSIMDFactory          from './vendor/jsquash-jxl/codec/enc/jxl_enc_mt_simd.js';
import jxlMtFactory              from './vendor/jsquash-jxl/codec/enc/jxl_enc_mt.js';
import decode                    from './vendor/jsquash-jxl/decode.js';
import { simd }                  from './vendor/wasm-feature-detect/index.js';

const _simdOk = simd(); // Promise<bool> — resolved once, reused on OOM retries

async function createModule() {
    return initEmscriptenModule(await _simdOk ? jxlMtSIMDFactory : jxlMtFactory);
}

// One live module instance; replaced after every abort.
let moduleP = createModule();

function isAbortError(err) {
    return (err instanceof WebAssembly.RuntimeError) || String(err).includes('Abort');
}

self.onmessage = async ({ data }) => {
    if (data.type === 'decode_jxl') {
        const { decodeId, url } = data;
        try {
            const resp = await fetch(url);
            const buf  = await resp.arrayBuffer();
            const img  = await decode(buf); // returns { data: Uint8ClampedArray, width, height }
            self.postMessage(
                { type: 'jxl_decoded', decodeId, rgba: img.data, w: img.width, h: img.height },
                [img.data.buffer],
            );
        } catch (err) {
            self.postMessage({ type: 'decode_error', decodeId, error: String(err?.message ?? err) });
        }
        return;
    }

    // --- encode path ---
    const { id, rgba, width, height, quality, effort, lossless } = data;
    const t0 = performance.now();
    try {
        let module = await moduleP;
        // Cap effort at 6 for images >15MP to avoid the OOM→reinit→retry cycle.
        const safeEffort = (width * height > 15_000_000) ? Math.min(effort, 6) : effort;
        let opts = { ...defaultOptions, quality, effort: safeEffort, lossless };
        let resultView;

        // Cascade down one effort level at a time on OOM (module is dead after
        // each abort and must be re-initialised before the next attempt).
        for (;;) {
            try {
                resultView = module.encode(new Uint8ClampedArray(rgba), width, height, opts);
                break;
            } catch (encErr) {
                if (isAbortError(encErr) && opts.effort > 5) {
                    const next = opts.effort - 1;
                    console.warn(`[jxl-worker] effort ${opts.effort} OOM for ${width}×${height}, retry at ${next}`);
                    moduleP = createModule();
                    module  = await moduleP;
                    opts    = { ...opts, effort: next };
                } else if (isAbortError(encErr)) {
                    // Effort already at minimum (5) and still OOM.  Reinit the
                    // module so subsequent encodes on this worker are not dead,
                    // then throw a human-readable error instead of raw 'abort'.
                    moduleP = createModule();
                    throw new Error(
                        `JXL encode OOM at minimum effort ${opts.effort} — image too large (${width}×${height})`
                    );
                } else {
                    throw encErr;
                }
            }
        }

        if (!resultView) throw new Error('Encoding error (null result).');
        const jxlMs = performance.now() - t0;

        const jxlBytes = new Uint8Array(
            resultView.buffer, resultView.byteOffset, resultView.byteLength,
        ).slice();

        self.postMessage(
            { id, type: 'done', jxl: jxlBytes, jxlMs, w: width, h: height,
              effortUsed: opts.effort, effortRequested: effort },
            [jxlBytes.buffer],
        );
    } catch (err) {
        self.postMessage({ id, type: 'encode_error', error: String(err?.message ?? err) });
    }
};
