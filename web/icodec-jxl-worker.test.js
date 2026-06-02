import { expect, test } from 'bun:test';
import initRaw, { process_orf, rgb_to_rgba } from './pkg/raw_converter_wasm.js';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
    createEncoder,
    createDecoder,
    setJxlModuleFactoryForTesting,
} from '../packages/jxl-wasm/dist/facade.js';

const DEFAULT_ORF_FOLDER = String.raw`C:\995\2026-02-20 Gobabeb To Windhoek`;

function firstOrfInFolder(folder) {
    if (!folder || !existsSync(folder)) return null;
    const first = readdirSync(folder)
        .filter((name) => name.toLowerCase().endsWith('.orf'))
        .sort((a, b) => a.localeCompare(b))[0];
    return first ? join(folder, first) : null;
}

const ORF_PATH = process.env.TEST_ORF ?? firstOrfInFolder(process.env.TEST_ORF_FOLDER ?? DEFAULT_ORF_FOLDER) ?? '';
const maybeFixtureTest = existsSync(ORF_PATH) ? test : test.skip;

maybeFixtureTest('jxl-wasm facade can encode and decode the full-size ORF via libjxl', async () => {
    setJxlModuleFactoryForTesting(null); // ensure real WASM, not a mock

    await initRaw();
    const bytes = readFileSync(ORF_PATH);
    const result = process_orf(bytes, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NaN, NaN, 0, 0);
    // Legacy WASM-side RGBA path removed per Boundary Cost Audit
    const rgba = rgb_to_rgba(result.take_rgb());
    const width = result.width;
    const height = result.height;
    result.free();

    // --- encode RGBA → JXL via libjxl WASM ---
    const encoder = createEncoder({
        format: 'rgba8',
        width,
        height,
        hasAlpha: true,
        iccProfile: null,
        exif: null,
        xmp: null,
        distance: null,
        quality: 90,
        effort: 3,
        progressive: true,
        previewFirst: false,
        chunked: false,
    });
    encoder.pushPixels(rgba.buffer);
    encoder.finish();

    const jxlChunks = [];
    for await (const chunk of encoder.chunks()) {
        jxlChunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    }
    expect(jxlChunks.length).toBeGreaterThan(0);

    const jxlTotalBytes = jxlChunks.reduce((s, c) => s + c.byteLength, 0);
    expect(jxlTotalBytes).toBeGreaterThan(0);

    const jxl = new Uint8Array(jxlTotalBytes);
    let off = 0;
    for (const c of jxlChunks) { jxl.set(c, off); off += c.byteLength; }

    // --- decode JXL → RGBA via libjxl WASM ---
    const decoder = createDecoder({
        format: 'rgba8',
        region: null,
        downsample: 1,
        progressionTarget: 'final',
        emitEveryPass: false,
        preserveIcc: false,
        preserveMetadata: false,
    });
    decoder.push(jxl.buffer);
    decoder.close();

    let finalEvent = null;
    for await (const event of decoder.events()) {
        if (event.type === 'final') {
            finalEvent = event;
        } else if (event.type === 'error') {
            throw new Error(`Decode error: ${event.message}`);
        }
    }

    expect(finalEvent).not.toBeNull();
    expect(finalEvent.info.width).toBe(width);
    expect(finalEvent.info.height).toBe(height);
    const pixelBytes = finalEvent.pixels instanceof Uint8Array
        ? finalEvent.pixels.byteLength
        : finalEvent.pixels.byteLength;
    expect(pixelBytes).toBe(width * height * 4);
}, 120000);
