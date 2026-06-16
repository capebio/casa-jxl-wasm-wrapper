import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';
import { createEncoder, createDecoder, detectTier, setForcedTier } from '../../packages/jxl-wasm/dist/index.js';
import { Worker as NodeWorker } from 'node:worker_threads';

class BrowserLikeWorker {
  #worker;
  #onmessage = null;
  #onerror = null;

  constructor(url, options = {}) {
    const workerUrl = url instanceof URL ? url.href : String(url);
    this.#worker = new NodeWorker(new URL('../../jxl-worker-shim.mjs', import.meta.url), {
      workerData: {
        url: workerUrl,
        name: options.name ?? '',
      },
    });
    this.#worker.on('message', (data) => {
      this.#onmessage?.({ data });
    });
    this.#worker.on('error', (error) => {
      this.#onerror?.(error);
    });
  }

  postMessage(message, transfer) {
    this.#worker.postMessage(message, transfer);
  }

  terminate() {
    return this.#worker.terminate();
  }

  set onmessage(handler) {
    this.#onmessage = handler;
  }
  get onmessage() {
    return this.#onmessage;
  }
  set onerror(handler) {
    this.#onerror = handler;
  }
  get onerror() {
    return this.#onerror;
  }
}

function exactBuffer(view) {
    if (view instanceof ArrayBuffer) return view;
    if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view.buffer;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

// ==========================================
// ENCODER TEST (Effort 3 vs 1)
// ==========================================

async function encodeJxl(rgba, width, height, effort) {
    const started = performance.now();
    const encoder = createEncoder({
        format: 'rgba8',
        width,
        height,
        hasAlpha: false,
        distance: 1.0,
        quality: 80,
        effort: effort,
        progressive: false,
        previewFirst: false,
        chunked: true,
    });

    const chunks = [];
    const chunkTask = (async () => {
        for await (const chunk of encoder.chunks()) {
            chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
        }
    })();

    await encoder.pushPixels(rgba);
    await encoder.finish();
    await chunkTask;
    await encoder.dispose();

    const total = chunks.reduce((s, c) => s + c.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }

    return { encodeMs: performance.now() - started, jxlBytes: out };
}

async function testEncodeEffort(filename, effort) {
    console.log(`\nEncoding ${filename} with Effort ${effort}...`);

    const jpegBuf = await readFile(filename);
    const { data: rgba, info } = await sharp(jpegBuf)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    const { encodeMs, jxlBytes } = await encodeJxl(rgba, info.width, info.height, effort);
    console.log(`  -> Encoded in ${encodeMs.toFixed(2)} ms (Size: ${jxlBytes.byteLength} bytes)`);
    
    // Save it so we can test decoding it
    const jxlFilename = `medium-thumb-e${effort}.jxl`;
    await writeFile(jxlFilename, jxlBytes);
    return jxlFilename;
}

// ==========================================
// DECODER TEST (Save to PNG)
// ==========================================

async function testDecodeDownsample(filename, downsample, outPng) {
    console.log(`\nDecoding ${filename} with Downsample ${downsample}...`);

    const jxlBytes = await readFile(filename);

    const decoder = createDecoder({
        format: 'rgba8',
        progressionTarget: 'final',
        emitEveryPass: false,
        downsample: downsample,
    });

    let finalPixels = null;
    let finalWidth = 0;
    let finalHeight = 0;

    let width = 0;
    let height = 0;

    const evTask = (async () => {
        for await (const ev of decoder.events()) {
            if (ev.type === 'error') throw new Error(`${ev.code}: ${ev.message}`);
            if (ev.type === 'header') {
                width = ev.info.width;
                height = ev.info.height;
            }
            if (ev.type === 'final') {
                finalPixels = ev.pixels;
                finalWidth = Math.ceil(width / downsample);
                finalHeight = Math.ceil(height / downsample);
            }
        }
    })();

    const tDecode0 = performance.now();
    await decoder.push(exactBuffer(jxlBytes));
    await decoder.close();
    await evTask;
    
    const decodeMs = performance.now() - tDecode0;
    console.log(`  -> Decoded down to ${finalWidth}x${finalHeight} in ${decodeMs.toFixed(2)} ms`);
    
    await decoder.dispose();

    if (finalPixels) {
        // We will output to PNG so you can easily compare visual quality side-by-side
        await sharp(Buffer.from(finalPixels), {
            raw: {
                width: finalWidth,
                height: finalHeight,
                channels: 4
            }
        }).png().toFile(outPng);
        console.log(`  -> Wrote output to ${outPng}`);
    } else {
        console.log("  -> Failed to capture decoded pixels.");
    }
}

async function main() {
    if (typeof Bun !== 'undefined') {
        setForcedTier('simd');
    } else if (typeof globalThis.Worker === 'undefined') {
        globalThis.Worker = BrowserLikeWorker;
        globalThis.navigator ??= {};
        globalThis.navigator.hardwareConcurrency ??= 8;
    }
    const tier = detectTier();
    console.log(`JXL WASM Tier: ${tier}\n`);

    const mediumJpeg = 'medium-thumb-fast.jpg';

    console.log("=== ENCODE OPTIMIZATION TESTS ===");
    console.log("Warming up thread pool...");
    await testEncodeEffort('absolute-smallest-thumb.jpg', 3);

    // 1. Generate Effort 3 and Effort 1
    const effort3Jxl = await testEncodeEffort(mediumJpeg, 3);
    const effort1Jxl = await testEncodeEffort(mediumJpeg, 1);

    console.log("\n=== DECODE COMPARISONS ===");
    
    // Decode Effort 3 (Baseline) to PNG
    await testDecodeDownsample(effort3Jxl, 1, 'compare-effort3-ds1.png');
    
    // Decode Effort 1 to PNG
    await testDecodeDownsample(effort1Jxl, 1, 'compare-effort1-ds1.png');

    // Decode Effort 1 Downsampled to PNG
    await testDecodeDownsample(effort1Jxl, 4, 'compare-effort1-ds4.png');
    
    // Yes, downsample 8 exists!
    await testDecodeDownsample(effort1Jxl, 8, 'compare-effort1-ds8.png');

    console.log("\nAll done.");
    process.exit(0);
}

main().catch(console.error);