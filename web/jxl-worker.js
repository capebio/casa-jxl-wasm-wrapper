// Dedicated JXL encode worker.
//
// Protocol:
//   main → worker: { id, rgba: ArrayBuffer, width, height, quality, effort, lossless, progressive }
//   worker → main: { id, type:'done',        jxl: Uint8Array, jxlMs, w, h,
//                    effortUsed, effortRequested }
//               or { id, type:'encode_error', error: string }
//
// Progressive decode sessions use the libjxl facade directly.
// One-shot URL decode (decode_jxl) is handled by jxl-decode-worker.js.

import { createDecoder as createLibjxlDecoder, createEncoder }
    from '../packages/jxl-wasm/dist/facade.js';

const decodeSessions = new Map();

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

    // --- encode path ---
    const { id, rgba, width, height, quality, effort, lossless, progressive } = data;
    const t0 = performance.now();
    try {
        const encoder = createEncoder({
            format: 'rgba8',
            width,
            height,
            hasAlpha: true,
            iccProfile: null,
            exif: null,
            xmp: null,
            distance: lossless ? 0 : null,
            quality: lossless ? null : quality,
            effort,
            progressive: Boolean(progressive),
            previewFirst: false,
            chunked: false,
        });
        encoder.pushPixels(rgba);
        encoder.finish();

        const parts = [];
        try {
            for await (const chunk of encoder.chunks()) {
                parts.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
            }
        } finally {
            encoder.dispose();
        }

        const totalLen = parts.reduce((n, a) => n + a.byteLength, 0);
        const jxlBytes = new Uint8Array(totalLen);
        let off = 0;
        for (const p of parts) { jxlBytes.set(p, off); off += p.byteLength; }

        const jxlMs = performance.now() - t0;
        self.postMessage(
            { id, type: 'done', jxl: jxlBytes, jxlMs, w: width, h: height,
              effortUsed: effort, effortRequested: effort },
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
