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
    await writeFile(`medium-thumb-e${effort}.jxl`, jxlBytes);
}

// ==========================================
// DECODER TEST (Downsample 1 vs 4)
// ==========================================

async function testDecodeDownsample(filename, downsample) {
    console.log(`\nDecoding ${filename} with Downsample ${downsample}...`);

    const jxlBytes = await readFile(filename);

    const decoder = createDecoder({
        format: 'rgba8',
        progressionTarget: 'final',
        emitEveryPass: false,
        downsample: downsample,
    });

    let width = 0;
    let height = 0;

    const evTask = (async () => {
        for await (const ev of decoder.events()) {
            if (ev.type === 'error') throw new Error(`${ev.code}: ${ev.message}`);
            if (ev.type === 'header') {
                width = ev.info.width;
                height = ev.info.height;
            }
        }
    })();

    const tDecode0 = performance.now();
    await decoder.push(exactBuffer(jxlBytes));
    await decoder.close();
    await evTask;
    
    const decodeMs = performance.now() - tDecode0;
    
    // Calculate expected output dimensions based on downsample factor
    const outWidth = Math.ceil(width / downsample);
    const outHeight = Math.ceil(height / downsample);

    console.log(`  -> Decoded ${width}x${height} down to ${outWidth}x${outHeight} in ${decodeMs.toFixed(2)} ms`);
    
    await decoder.dispose();
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
    // Warm up the thread pool first to ensure fair testing
    console.log("Warming up thread pool...");
    await testEncodeEffort('absolute-smallest-thumb.jpg', 3);

    // Test Medium Thumb Encoding (Effort 3 vs 1)
    await testEncodeEffort(mediumJpeg, 3);
    await testEncodeEffort(mediumJpeg, 1);

    console.log("\n=== DECODE OPTIMIZATION TESTS ===");
    // Test Medium Thumb Decoding (Downsample 1 vs 4)
    // We'll use the effort 1 JXL file generated above
    const mediumJxl = 'medium-thumb-e1.jxl';
    await testDecodeDownsample(mediumJxl, 1); // Full resolution
    await testDecodeDownsample(mediumJxl, 4); // 1/4 resolution

    console.log("\nAll done.");
    process.exit(0);
}

main().catch(console.error);