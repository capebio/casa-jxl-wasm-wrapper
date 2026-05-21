import { expect, test } from 'bun:test';
import initRaw, { process_orf, rgb_to_rgba } from '../pkg/raw_converter_wasm.js';
import { readFileSync } from 'node:fs';

const ORF_PATH = String.raw`C:\995\2026-02-17 Dave at Kyffhauser\PC280038.ORF`;

function waitFor(messages, predicate) {
    return new Promise((resolve, reject) => {
        const started = performance.now();
        const timer = setInterval(() => {
            const match = messages.find(predicate);
            if (match) {
                clearInterval(timer);
                resolve(match);
                return;
            }
            if (performance.now() - started > 120000) {
                clearInterval(timer);
                reject(new Error('timed out waiting for worker message'));
            }
        }, 25);
    });
}

test('icodec jxl worker can encode and decode the full-size ORF', async () => {
    const originalSelf = globalThis.self;
    const originalImageData = globalThis.ImageData;
    const messages = [];

    try {
        globalThis.ImageData = globalThis.ImageData || class ImageData {
            constructor(data, width, height) {
                this.data = data;
                this.width = width;
                this.height = height;
            }
        };
        globalThis.self = {
            postMessage(message) {
                messages.push(message);
            },
        };

        await initRaw();
        await import('./icodec-jxl-worker.js');

        const bytes = readFileSync(ORF_PATH);
        const result = process_orf(bytes, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NaN, NaN, 0, 0);
        const rgba = rgb_to_rgba(result.take_rgb());
        const width = result.width;
        const height = result.height;
        result.free();

        self.onmessage({
            data: {
                id: 'enc-1',
                type: 'encode_request',
                rgba: rgba.buffer,
                width,
                height,
                quality: 90,
                effort: 3,
                lossless: false,
                progressive: true,
            },
        });

        const encodeMsg = await waitFor(messages, (message) => message.type === 'done' && message.id === 'enc-1');
        expect(encodeMsg.jxlMs).toBeGreaterThan(0);
        expect(encodeMsg.jxl.byteLength).toBeGreaterThan(0);

        const blob = new Blob([encodeMsg.jxl], { type: 'image/jxl' });
        const url = URL.createObjectURL(blob);
        try {
            self.onmessage({
                data: {
                    type: 'decode_jxl',
                    decodeId: 'dec-1',
                    url,
                },
            });

            const decodeMsg = await waitFor(messages, (message) => message.type === 'jxl_decoded' && message.decodeId === 'dec-1');
            expect(decodeMsg.w).toBe(width);
            expect(decodeMsg.h).toBe(height);
            expect(decodeMsg.rgba.byteLength).toBe(width * height * 4);
        } finally {
            URL.revokeObjectURL(url);
        }
    } finally {
        globalThis.self = originalSelf;
        globalThis.ImageData = originalImageData;
    }
}, 120000);
