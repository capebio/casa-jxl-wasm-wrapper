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
    if (!pixels) return pixels;
    if (pixels instanceof ArrayBuffer) return new Uint8ClampedArray(pixels);
    const view = (pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray) ? pixels : new Uint8Array(pixels);
    return new Uint8ClampedArray(view.buffer, view.byteOffset, view.byteLength);
}

// Scan JXL container bytes for embedded JPEG bitstreams (SOI..EOI).
// Used for JXTC/reconstruction containers to emit jxl_recon_jpeg before
// the progressive RGBA path, enabling native-JPEG first-paint in the browser.
function extractEmbeddedJpegs(bytes) {
    const sois = [];
    for (let i = 0; i < bytes.length - 2; i++) {
        if (bytes[i] === 0xFF && bytes[i + 1] === 0xD8 && bytes[i + 2] === 0xFF) {
            sois.push(i);
            i += 2;
        }
    }
    const blobs = [];
    for (let n = 0; n < sois.length; n++) {
        const start = sois[n];
        const end = n + 1 < sois.length ? sois[n + 1] : bytes.length;
        let eoi = -1;
        for (let j = end - 2; j >= start + 2; j--) {
            if (bytes[j] === 0xFF && bytes[j + 1] === 0xD9) { eoi = j; break; }
        }
        if (eoi !== -1) blobs.push(bytes.slice(start, eoi + 2));
    }
    return blobs;
}

function buildAnimMeta(ev) {
    const m = { hasAnimation: !!(ev.info?.hasAnimation) };
    if (ev.frameDuration !== undefined)       m.frameDuration       = ev.frameDuration;
    if (ev.animTicksPerSecond !== undefined)  m.animTicksPerSecond  = ev.animTicksPerSecond;
    if (ev.isLastFrame !== undefined)         m.isLastFrame         = ev.isLastFrame;
    if (ev.frameIndex !== undefined)          m.frameIndex          = ev.frameIndex;
    if (ev.frameName !== undefined)           m.frameName           = ev.frameName;
    if (ev.animLoopCount !== undefined)       m.animLoopCount       = ev.animLoopCount;
    return m;
}

async function decodeWithJsquashFallback(decodeId, buf) {
    const img = await decodeFallback(buf);
    self.postMessage(
        { type: 'jxl_decoded', decodeId, rgba: img.data, w: img.width, h: img.height },
        [img.data.buffer],
    );
}

async function decodeProgressive(decodeId, buf, data) {
    const { progressiveDetail, region, downsample, frameIndex, previewFirst } = data;

    // JXTC extraction: scan for embedded JPEG before any WASM decode work.
    // Only container JXLs (jpegReconstructionAvailable) carry these; pure JXLs skip silently.
    if (data.jpegReconstructionAvailable) {
        try {
            const bytes = new Uint8Array(buf);
            const jpegs = extractEmbeddedJpegs(bytes);
            if (jpegs.length > 0) {
                const jpeg = jpegs[0];
                self.postMessage(
                    { type: 'jxl_recon_jpeg', decodeId, jpeg, frameIndex: frameIndex ?? 0 },
                    [jpeg.buffer],
                );
            }
        } catch (_) { /* non-fatal */ }
    }

    // previewFirst: DC-only decode at downsample=2 for fast low-res first paint.
    // Emits jxl_preview before the full progressive decode starts.
    if (previewFirst) {
        let previewDec = null;
        try {
            previewDec = createDecoder({
                format: 'rgba8',
                region: null,
                downsample: 2,
                progressionTarget: 'final',
                emitEveryPass: false,
                progressiveDetail: 'dc',
                frameIndex: frameIndex ?? 0,
                preserveIcc: true,
                preserveMetadata: true,
            });
            await previewDec.push(buf);
            await previewDec.close();
            let psw = 0, psh = 0;
            for await (const ev of previewDec.events()) {
                if (ev.type === 'header') {
                    psw = ev.info.width;
                    psh = ev.info.height;
                    self.postMessage({
                        type: 'jxl_header', decodeId,
                        w: psw, h: psh,
                        hasAnimation: !!ev.info.hasAnimation,
                        jpegReconstructionAvailable: !!ev.info.jpegReconstructionAvailable,
                    });
                } else if (ev.type === 'progress' || ev.type === 'final') {
                    let px = ev.pixels instanceof Uint8Array ? ev.pixels : new Uint8Array(ev.pixels);
                    if (px.byteOffset !== 0 || px.byteLength !== px.buffer.byteLength) px = new Uint8Array(px);
                    self.postMessage(
                        {
                            type: 'jxl_preview', decodeId,
                            rgba: px, w: ev.info.width, h: ev.info.height,
                            isFinal: true, sourceW: psw, sourceH: psh,
                            downsample: 2, progressiveDetail: 'dc',
                            ...buildAnimMeta(ev),
                            jpegReconstructionAvailable: !!ev.info.jpegReconstructionAvailable,
                        },
                        [px.buffer],
                    );
                }
            }
        } catch (e) {
            console.warn('[jxl-decode-worker] previewFirst failed:', e);
        } finally {
            if (previewDec) try { previewDec.dispose(); } catch (_) {}
        }
    }

    // Main progressive decode (full quality, respects region/downsample/frameIndex).
    const decoder = createDecoder({
        format: 'rgba8',
        region: region ?? null,
        downsample: downsample ?? 1,
        progressionTarget: 'final',
        emitEveryPass: true,
        progressiveDetail: progressiveDetail ?? 'lastPasses',
        frameIndex: frameIndex ?? 0,
        preserveIcc: true,
        preserveMetadata: true,
    });

    try {
        let sourceW = 0, sourceH = 0;
        const events = (async () => {
            let sawFinal = false;
            for await (const ev of decoder.events()) {
                if (ev.type === 'header') {
                    sourceW = ev.info.width;
                    sourceH = ev.info.height;
                    self.postMessage({
                        type: 'jxl_header', decodeId,
                        w: sourceW, h: sourceH,
                        hasAnimation: !!ev.info.hasAnimation,
                        jpegReconstructionAvailable: !!ev.info.jpegReconstructionAvailable,
                    });
                } else if (ev.type === 'progress' || ev.type === 'final') {
                    const isFinal = ev.type === 'final';
                    let px = ev.pixels instanceof Uint8Array ? ev.pixels : new Uint8Array(ev.pixels);
                    if (px.byteOffset !== 0 || px.byteLength !== px.buffer.byteLength) px = new Uint8Array(px);

                    const base = {
                        decodeId, w: ev.info.width, h: ev.info.height,
                        sourceW, sourceH, isFinal,
                        progressiveDetail: progressiveDetail ?? 'lastPasses',
                        frameIndex: frameIndex ?? 0,
                        stage: ev.stage,
                        ...buildAnimMeta(ev),
                        jpegReconstructionAvailable: !!ev.info.jpegReconstructionAvailable,
                        ...(region != null || downsample != null
                            ? { region: region ?? null, downsample: downsample ?? 1 }
                            : {}),
                    };

                    if (isFinal) {
                        sawFinal = true;
                        const copy = new Uint8Array(px);
                        self.postMessage({ type: 'jxl_progress', ...base, rgba: px },  [px.buffer]);
                        self.postMessage({ type: 'jxl_decoded',  ...base, rgba: copy }, [copy.buffer]);
                    } else {
                        self.postMessage({ type: 'jxl_progress', ...base, rgba: px }, [px.buffer]);
                    }
                } else if (ev.type === 'error') {
                    throw new Error(`${ev.code}: ${ev.message}`);
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
                await decodeProgressive(decodeId, buf, data);
                return;
            } catch (err) {
                console.warn('[jxl-decode-worker] progressive failed; falling back to jsquash:', err);
            }
        }
        await decodeWithJsquashFallback(decodeId, buf);
    } catch (err) {
        self.postMessage({ type: 'decode_error', decodeId, error: String(err?.message ?? err) });
    }
};
