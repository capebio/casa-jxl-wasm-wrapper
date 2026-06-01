// Dedicated JXL decode worker. Kept separate from jxl-worker.js (encoder) so
// long encode work cannot block production lightbox decode requests.
import { createDecoder, preloadJxlModule } from '../packages/jxl-wasm/dist/index.js';
import decodeFallback from './vendor/jsquash-jxl/decode.js';

try {
    preloadJxlModule();
} catch (err) {
    console.warn('JXL preload failed:', err);
}

function asTightRgba(pixels) {
    if (pixels instanceof ArrayBuffer) return new Uint8ClampedArray(pixels);
    if (pixels.byteOffset === 0 && pixels.byteLength === pixels.buffer.byteLength) {
        return pixels instanceof Uint8ClampedArray ? pixels : new Uint8ClampedArray(pixels.buffer);
    }
    return new Uint8ClampedArray(pixels);
}

function copyPixels(pixels) {
    const src = asTightRgba(pixels);
    return new Uint8ClampedArray(src);
}

function postProgress(decodeId, event, isFinal) {
    const rgba = asTightRgba(event.pixels);
    self.postMessage(
        {
            type: 'jxl_progress',
            decodeId,
            rgba,
            w: event.info.width,
            h: event.info.height,
            isFinal,
        },
        [rgba.buffer],
    );
}

function postDecoded(decodeId, event) {
    const rgba = asTightRgba(event.pixels);
    self.postMessage(
        { type: 'jxl_decoded', decodeId, rgba, w: event.info.width, h: event.info.height },
        [rgba.buffer],
    );
}

async function decodeWithJsquashFallback(decodeId, buf) {
    const img = await decodeFallback(buf);
    self.postMessage(
        { type: 'jxl_decoded', decodeId, rgba: img.data, w: img.width, h: img.height },
        [img.data.buffer],
    );
}

async function decodeProgressive(decodeId, buf, progressiveDetail) {
    const decoder = createDecoder({
        format: 'rgba8',
        region: null,
        downsample: 1,
        progressionTarget: 'final',
        emitEveryPass: true,
        progressiveDetail: progressiveDetail ?? 'lastPasses',
        preserveIcc: true,
        preserveMetadata: true,
    });

    try {
        const events = (async () => {
            let sawFinal = false;
            for await (const event of decoder.events()) {
                if (event.type === 'progress') {
                    postProgress(decodeId, event, false);
                } else if (event.type === 'final') {
                    sawFinal = true;
                    const rgba = asTightRgba(event.pixels);
                    const copy = new Uint8ClampedArray(rgba);
                    self.postMessage({ type: 'jxl_progress', decodeId, rgba, w: event.info.width, h: event.info.height, isFinal: true }, [rgba.buffer]);
                    self.postMessage({ type: 'jxl_decoded', decodeId, rgba: copy, w: event.info.width, h: event.info.height }, [copy.buffer]);
                } else if (event.type === 'error') {
                    throw new Error(`${event.code}: ${event.message}`);
                }
            }
            if (!sawFinal) throw new Error('No final JXL frame decoded');
        })();

        await decoder.push(buf);
        await decoder.close();
        await events;
    } finally {
        await decoder.dispose();
    }
}

self.onmessage = async ({ data }) => {
    if (data.type === 'preload') {
        try { preloadJxlModule(); } catch {}
        return;
    }
    if (data.type !== 'decode_jxl') return;

    const { decodeId, url } = data;
    try {
        const resp = await fetch(url);
        const buf = await resp.arrayBuffer();
        if (data.progressive) {
            try {
                await decodeProgressive(decodeId, buf, data.progressiveDetail);
                return;
            } catch (err) {
                console.warn('progressive JXL decode failed; falling back to jsquash:', err);
            }
        }
        await decodeWithJsquashFallback(decodeId, buf);
    } catch (err) {
        self.postMessage({ type: 'decode_error', decodeId, error: String(err?.message ?? err) });
    }
};
