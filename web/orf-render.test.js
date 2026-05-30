import { expect, test } from 'bun:test';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import initRaw, { process_orf, rgb_to_rgba } from './pkg/raw_converter_wasm.js';
import { encodeBackendForTarget } from './jxl-progressive-policy.js';

const ORF_FOLDER = String.raw`C:\995\2026-02-17 Dave at Kyffhauser`;
const SELECTED_COUNT = 2;
const ENCODE_BACKENDS = ['jsquash', 'libjxl'];
const PROGRESSIVE_MODES = [false, true];

function getOrfEntries() {
    if (!existsSync(ORF_FOLDER)) {
        throw new Error(`ORF ingest folder not found: ${ORF_FOLDER}`);
    }

    const entries = readdirSync(ORF_FOLDER)
        .filter((name) => name.toLowerCase().endsWith('.orf'))
        .map((name) => ({
            name,
            path: join(ORF_FOLDER, name),
            size: readFileSync(join(ORF_FOLDER, name)).byteLength,
        }))
        .sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));

    if (!entries.length) {
        throw new Error(`No ORF files found in ${ORF_FOLDER}`);
    }
    return entries.slice(0, SELECTED_COUNT).map((entry) => ({
        ...entry,
        bytes: readFileSync(entry.path),
    }));
}

function makeWorker(script) {
    return new Worker(new URL(script, import.meta.url), { type: 'module' });
}

function encodeJxl(worker, rgba, width, height, quality = 90, effort = 3, progressive = true) {
    return new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        const onMessage = ({ data }) => {
            if (data.id !== id) return;
            worker.removeEventListener('message', onMessage);
            if (data.type === 'done') resolve(data);
            else reject(new Error(data.error || 'JXL encode failed'));
        };
        worker.addEventListener('message', onMessage);
        worker.postMessage({
            id,
            type: 'encode_request',
            rgba: rgba.buffer,
            width,
            height,
            quality,
            effort,
            lossless: false,
            progressive,
        }, [rgba.buffer]);
    });
}

function decodeJxl(worker, url) {
    return new Promise((resolve, reject) => {
        const decodeId = crypto.randomUUID();
        const onMessage = ({ data }) => {
            if (data.decodeId !== decodeId) return;
            worker.removeEventListener('message', onMessage);
            if (data.type === 'jxl_decoded') resolve(data);
            else reject(new Error(data.error || 'JXL decode failed'));
        };
        worker.addEventListener('message', onMessage);
        worker.postMessage({ type: 'decode_jxl', decodeId, url });
    });
}

async function decodeJxlBytes(worker, bytes) {
    const blob = new Blob([bytes], { type: 'image/jxl' });
    const url = URL.createObjectURL(blob);
    try {
        return await decodeJxl(worker, url);
    } finally {
        URL.revokeObjectURL(url);
    }
}

async function stage(label, fileName, fn) {
    const started = performance.now();
    try {
        const value = await fn();
        return { value, ms: performance.now() - started };
    } catch (error) {
        const message = error?.message || String(error);
        throw new Error(`${label} failed for ${fileName}: ${message}`);
    }
}

test('renders two ORFs across backend and progressive permutations', async () => {
    const sources = getOrfEntries();
    await initRaw();

    const decodeWorkerScript = './jxl-decode-worker.js';
    const decodeWorker = makeWorker(decodeWorkerScript);
    const failures = [];
    let passCount = 0;

    try {
        const warmupRgba = new Uint8Array(4 * 4 * 4);
        const warmupWorker = makeWorker('./icodec-jxl-worker.js');
        const warmupEncoded = await encodeJxl(warmupWorker, warmupRgba, 4, 4, 1, 1);
        await decodeJxlBytes(decodeWorker, warmupEncoded.jxl);
        warmupWorker.terminate();

        for (const source of sources) {
            const { value: decodedSource, ms: orfMs } = await stage('ORF decode', source.name, async () => {
                const result = process_orf(source.bytes, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NaN, NaN, 0, 0);
                try {
                    const rgb = result.take_rgb();
                    expect(result.width).toBeGreaterThan(0);
                    expect(result.height).toBeGreaterThan(0);
                    expect(rgb.length).toBe(result.width * result.height * 3);
                    return {
                        width: result.width,
                        height: result.height,
                        rgb,
                    };
                } finally {
                    result.free();
                }
            });

            const rgba = rgb_to_rgba(decodedSource.rgb);
            const sourceSummary = `${source.name} (${source.size} B, ${decodedSource.width}x${decodedSource.height})`;
            for (const requestedBackend of ENCODE_BACKENDS) {
                for (const progressive of PROGRESSIVE_MODES) {
                    const actualBackend = encodeBackendForTarget(requestedBackend, decodedSource.width, decodedSource.height);
                    const worker = makeWorker(actualBackend === 'libjxl' ? './icodec-jxl-worker.js' : './jxl-worker.js');
                    const tag = `${sourceSummary} | req ${requestedBackend} -> ${actualBackend} | progressive=${progressive ? 'on' : 'off'}`;
                    try {
                        const warmupBytes = new Uint8Array(4 * 4 * 4);
                        const warmup = await encodeJxl(worker, warmupBytes, 4, 4, 1, 1, progressive);
                        await decodeJxlBytes(decodeWorker, warmup.jxl);
                        const encodeInput = new Uint8Array(rgba);
                        const { value: encodeResult, ms: encodeMs } = await stage('JXL encode', source.name, async () => (
                            encodeJxl(worker, encodeInput, decodedSource.width, decodedSource.height, 90, 3, progressive)
                        ));

                        const { value: decodedJxl, ms: decodeMs } = await stage('JXL decode', source.name, async () => (
                            decodeJxlBytes(decodeWorker, encodeResult.jxl)
                        ));

                        expect(decodedJxl.w).toBe(decodedSource.width);
                        expect(decodedJxl.h).toBe(decodedSource.height);
                        expect(decodedJxl.rgba.length).toBe(decodedSource.width * decodedSource.height * 4);

                        console.info(
                            `${tag} | ORF decode ${orfMs.toFixed(0)} ms | ` +
                            `JXL encode ${encodeMs.toFixed(0)} ms | ` +
                            `JXL decode ${decodeMs.toFixed(0)} ms | ` +
                            `shows=yes`,
                        );
                        passCount += 1;
                    } catch (error) {
                        const message = error?.message || String(error);
                        console.info(`${tag} | ERROR ${message}`);
                        failures.push(`${tag}: ${message}`);
                    } finally {
                        worker.terminate();
                    }
                }
            }
        }

        console.info(`summary: ${passCount} pass, ${failures.length} fail`);
    } finally {
        decodeWorker.terminate();
    }
}, 600000);
