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
// At high effort on large images the WASM heap can run out.  When that
// happens the module becomes permanently unusable (ABORT flag is set).
// Fail fast instead of retrying lower efforts: the lower-effort ladder never
// recovered large-image encodes reliably and only poisoned the worker.

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
    const { id, rgba, width, height, quality, effort, lossless, progressive } = data;
    const t0 = performance.now();
    try {
        let module = await moduleP;
        const opts = { ...defaultOptions, quality, effort, lossless, progressive: Boolean(progressive) };
        let resultView;
        try {
            resultView = module.encode(new Uint8ClampedArray(rgba), width, height, opts);
        } catch (encErr) {
            if (isAbortError(encErr)) {
                // Re-init so the worker is usable for later, smaller jobs.
                moduleP = createModule();
                throw new Error(
                    `JXL encode OOM at effort ${opts.effort} — image too large (${width}×${height})`
                );
            }
            throw encErr;
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
