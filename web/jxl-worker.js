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
import { createDecoder as createLibjxlDecoder } from '../packages/jxl-wasm/dist/facade.js';
const _simdOk = simd(); // Promise<bool> — resolved once, reused on OOM retries

async function createModule() {
    return initEmscriptenModule(await _simdOk ? jxlMtSIMDFactory : jxlMtFactory);
}

// One live module instance; replaced after every abort.
let moduleP = createModule();
const decodeSessions = new Map();

function isAbortError(err) {
    return (err instanceof WebAssembly.RuntimeError) || String(err).includes('Abort');
}

self.onmessage = async ({ data }) => {
    if (data.type === 'decode_start') {
        startDecodeSession(data);
        return;
    }

    if (data.type === 'decode_chunk') {
        decodeSessions.get(data.sessionId)?.push(data.chunk);
        return;
    }

    if (data.type === 'decode_close') {
        decodeSessions.get(data.sessionId)?.close();
        return;
    }

    if (data.type === 'decode_cancel') {
        await decodeSessions.get(data.sessionId)?.cancel(data.reason);
        return;
    }

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

function startDecodeSession(msg) {
    if (decodeSessions.has(msg.sessionId)) {
        decodeSessions.get(msg.sessionId)?.cancel('session replaced');
    }

    const session = new ProgressiveDecodeSession(msg);
    decodeSessions.set(msg.sessionId, session);
}

class ProgressiveDecodeSession {
    constructor(msg) {
        this.sessionId = msg.sessionId;
        this.cancelled = false;
        this.closed = false;
        this.ended = false;
        this.decoder = createLibjxlDecoder({
            format: msg.format,
            region: msg.region,
            downsample: msg.downsample,
            progressionTarget: msg.progressionTarget,
            emitEveryPass: msg.emitEveryPass,
            preserveIcc: msg.preserveIcc,
            preserveMetadata: msg.preserveMetadata,
        });
        this.run();
    }

    push(chunk) {
        if (this.cancelled || this.ended) return;
        this.decoder.push(chunk);
    }

    close() {
        if (this.cancelled || this.ended || this.closed) return;
        this.closed = true;
        this.decoder.close();
    }

    async cancel(reason) {
        if (this.cancelled || this.ended) return;
        this.cancelled = true;
        try {
            await this.decoder.cancel(reason);
        } catch {}
        this.finish();
        self.postMessage({ type: 'decode_cancelled', sessionId: this.sessionId });
    }

    async run() {
        try {
            for await (const event of this.decoder.events()) {
                if (this.cancelled || this.ended) return;
                if (event.type === 'header') {
                    self.postMessage({ type: 'decode_header', sessionId: this.sessionId, info: event.info });
                    continue;
                }
                if (event.type === 'progress') {
                    this.postFrame('decode_progress', event);
                    continue;
                }
                if (event.type === 'final') {
                    this.postFrame('decode_final', event);
                    this.finish();
                    return;
                }
                if (event.type === 'error') {
                    self.postMessage({
                        type: 'decode_error',
                        sessionId: this.sessionId,
                        code: event.code || 'DecodeFailed',
                        message: event.message || 'Decode failed',
                    });
                    this.finish();
                    return;
                }
            }
        } catch (err) {
            if (!this.cancelled) {
                self.postMessage({
                    type: 'decode_error',
                    sessionId: this.sessionId,
                    code: 'DecodeFailed',
                    message: String(err?.message ?? err),
                });
            }
            this.finish();
        }
    }

    postFrame(type, event) {
        const pixels = toTransferableArrayBuffer(event.pixels);
        const message = {
            type,
            sessionId: this.sessionId,
            stage: event.stage,
            info: event.info,
            pixels,
            format: event.format,
            pixelStride: event.pixelStride,
        };
        if (event.region !== undefined) {
            message.region = event.region;
        }
        self.postMessage(message, [pixels]);
    }

    finish() {
        if (this.ended) return;
        this.ended = true;
        decodeSessions.delete(this.sessionId);
        try {
            this.decoder.dispose();
        } catch {}
    }
}

function toTransferableArrayBuffer(value) {
    if (value instanceof ArrayBuffer) return value;
    if (value instanceof Uint8Array) {
        return value.byteOffset === 0 && value.byteLength === value.buffer.byteLength
            ? value.buffer
            : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    }
    return new Uint8Array(value).buffer;
}
