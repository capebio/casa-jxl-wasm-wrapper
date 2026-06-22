import * as jxl from '../node_modules/icodec/lib/jxl.js';
import { PureImageData } from '../node_modules/icodec/lib/common.js';
import { buildIcodecJxlOptions } from './icodec-jxl-options.js';

const encoderWasmUrl = new URL('../node_modules/icodec/dist/jxl-enc.wasm', import.meta.url).href;
const decoderWasmUrl = new URL('../node_modules/icodec/dist/jxl-dec.wasm', import.meta.url).href;

let encoderReady = null;
let decoderReady = null;

if (typeof globalThis.ImageData !== 'function') {
    globalThis.ImageData = class ImageData {
        constructor(data, width, height) {
            this.data = data;
            this.width = width;
            this.height = height;
        }
    };
}

if (!globalThis._icodec_ImageData) {
    globalThis._icodec_ImageData = (data, width, height, depth = 8) => {
        // Defensive: icodec always packs width*height*4 channel elements (RGBA),
        // at 1 byte/element for depth 8 and 2 bytes/element above. Validate the
        // buffer covers that before wrapping it, so a short/garbage buffer fails
        // loudly here instead of producing an ImageData that reads OOB downstream.
        const bytesPerElement = depth === 8 ? 1 : 2;
        const expectedBytes = width * height * 4 * bytesPerElement;
        if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
            throw new RangeError(`_icodec_ImageData: invalid dimensions ${width}x${height}`);
        }
        if (typeof data?.byteLength !== 'number' || data.byteLength < expectedBytes) {
            throw new RangeError(
                `_icodec_ImageData: data.byteLength (${data?.byteLength}) < expected ${expectedBytes} for ${width}x${height}@${depth}bpc`,
            );
        }
        if (depth === 8 && typeof ImageData === 'function') {
            return new ImageData(data, width, height);
        }
        return new PureImageData(data, width, height, depth);
    };
}

async function ensureEncoder() {
    encoderReady ??= jxl.loadEncoder(encoderWasmUrl);
    return encoderReady;
}

async function ensureDecoder() {
    decoderReady ??= jxl.loadDecoder(decoderWasmUrl);
    return decoderReady;
}

self.onmessage = async ({ data }) => {
    if (data.type === 'decode_jxl') {
        const { decodeId, url } = data;
        try {
            await ensureDecoder();
            const resp = await fetch(url);
            const buf = new Uint8Array(await resp.arrayBuffer());
            const img = jxl.decode(buf);
            self.postMessage(
                { type: 'jxl_decoded', decodeId, rgba: img.data, w: img.width, h: img.height },
                [img.data.buffer],
            );
        } catch (err) {
            self.postMessage({ type: 'decode_error', decodeId, error: String(err?.message ?? err) });
        }
        return;
    }

    const { id, rgba, width, height, quality, effort, lossless, progressive, progressiveFlavor } = data;
    const t0 = performance.now();
    try {
        await ensureEncoder();
        const result = jxl.encode(
            { data: new Uint8ClampedArray(rgba), width, height, depth: 8 },
            buildIcodecJxlOptions({
                quality,
                effort,
                lossless,
                progressive,
                progressiveFlavor,
                width,
                height,
            }),
        );
        const jxlMs = performance.now() - t0;
        const jxlBytes = new Uint8Array(result.buffer, result.byteOffset, result.byteLength).slice();
        self.postMessage(
            {
                id,
                type: 'done',
                jxl: jxlBytes,
                jxlMs,
                w: width,
                h: height,
                effortUsed: effort,
                effortRequested: effort,
            },
            [jxlBytes.buffer],
        );
    } catch (err) {
        self.postMessage({ id, type: 'encode_error', error: String(err?.message ?? err) });
    }
};
