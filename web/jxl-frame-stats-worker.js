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
    const { pixels, width, height } = data;
    try {
        const input = pixels instanceof Uint8Array ? pixels : new Uint8Array(pixels ?? new ArrayBuffer(0));
        const stats = analyzeProgressiveFrame(input, width, height);
        const output = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
        self.postMessage({ id, ok: true, stats, pixels: output }, [output]);
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
            return {
                index: p.index,
                psnr: computePsnrVsFinal(refPx, px),
                ssim: computeSsimVsFinal(refPx, px, refWidth, refHeight),
                butt: computeButteraugliVsFinal(refXyb, px, refWidth, refHeight),
            };
        });
        self.postMessage({ id, ok: true, type: 'chart', values });
    } catch (error) {
        self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
}
