import { analyzeProgressiveFrame } from './jxl-progressive-frame-stats.js';
import { computePsnrVsFinal, computeSsimVsFinal } from './jxl-progressive-quality.js';
import { pixelsToXyb, computeButteraugliVsFinal } from './jxl-butteraugli.js';

self.onmessage = (event) => {
    const { id, type } = event.data ?? {};
    if (type === 'chart') {
        handleChartRequest(id, event.data);
    } else {
        handleFrameStats(id, event.data);
    }
};

function handleFrameStats(id, data) {
    const { pixels, width, height, returnPixels = true } = data ?? {};
    try {
        const input = pixels instanceof Uint8Array ? pixels : new Uint8Array(pixels ?? new ArrayBuffer(0));
        const stats = analyzeProgressiveFrame(input, width, height);
        let pixField = undefined;
        const xfer = [];
        if (returnPixels) {
            const output = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
            pixField = output;
            xfer.push(output);
        }
        self.postMessage({ id, ok: true, stats, pixels: pixField }, xfer);
    } catch (error) {
        self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
}

function handleChartRequest(id, data) {
    const { ref, refWidth, refHeight, passes } = data;
    try {
        const refPx = new Uint8Array(ref);
        const n = refWidth * refHeight;
        const refXyb = pixelsToXyb(refPx, n);
        const values = passes.map(p => {
            if (!p) return null;
            const px = new Uint8Array(p.buf);
            const rec = {
                index: p.index,
                psnr: computePsnrVsFinal(refPx, px),
                ssim: computeSsimVsFinal(refPx, px, refWidth, refHeight),
            };
            if (data.includeButter !== false) {
                rec.butt = computeButteraugliVsFinal(refXyb, px, refWidth, refHeight);
            } else {
                rec.butt = null;
            }
            return rec;
        });
        self.postMessage({ id, ok: true, type: 'chart', values });
    } catch (error) {
        self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
}
