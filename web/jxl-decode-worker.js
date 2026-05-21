// Dedicated JXL decode worker — kept separate from jxl-worker.js (encoder) so
// that a long Emscripten-pthread encode cannot block lightbox decode requests.
import decode from './vendor/jsquash-jxl/decode.js';

self.onmessage = async ({ data }) => {
    const { decodeId, url } = data;
    try {
        const resp = await fetch(url);
        const buf  = await resp.arrayBuffer();
        const img  = await decode(buf);
        self.postMessage(
            { type: 'jxl_decoded', decodeId, rgba: img.data, w: img.width, h: img.height },
            [img.data.buffer],
        );
    } catch (err) {
        self.postMessage({ type: 'decode_error', decodeId, error: String(err?.message ?? err) });
    }
};
