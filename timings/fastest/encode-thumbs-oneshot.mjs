import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';
import { createEncoder, detectTier, setForcedTier } from '../../packages/jxl-wasm/dist/index.js';
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

function stamp(t0, label) {
    const ms = performance.now() - t0;
    console.log(`[t+${ms.toFixed(2).padStart(8)} ms] ${label}`);
    return ms;
}

// Our favourite JXL encoder wrapper and settings (single-shot version)
async function encodeJxl(rgba, width, height) {
    const started = performance.now();
    const encoder = createEncoder({
        format: 'rgba8',
        width,
        height,
        hasAlpha: false,
        distance: 1.0,
        quality: 80,
        effort: 3,
        progressive: false, // <-- Disabled progressive encoding
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

async function processThumb(filename, outFilename) {
    const t0 = performance.now();
    console.log(`Processing ${filename}...`);

    // 1. Read JPEG
    const jpegBuf = await readFile(filename);
    stamp(t0, `Read ${jpegBuf.length} bytes`);

    // 2. Decode JPEG to RGBA using sharp
    const { data: rgba, info } = await sharp(jpegBuf)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    stamp(t0, `Decoded to RGBA (${info.width}x${info.height})`);

    // 3. Encode to JXL
    const { encodeMs, jxlBytes } = await encodeJxl(rgba, info.width, info.height);
    stamp(t0, `Encoded to JXL in ${encodeMs.toFixed(2)} ms (${jxlBytes.byteLength} bytes)`);

    // 4. Write JXL
    await writeFile(outFilename, jxlBytes);
    stamp(t0, `Wrote ${outFilename}`);
}

async function main() {
    if (typeof Bun !== 'undefined') {
        // Bun's Worker implementation throws InvalidStateError for MT wasm pools currently
        setForcedTier('simd');
    } else if (typeof globalThis.Worker === 'undefined') {
        // Node polyfill for MT
        globalThis.Worker = BrowserLikeWorker;
        globalThis.navigator ??= {};
        globalThis.navigator.hardwareConcurrency ??= 8;
    }
    const tier = detectTier();
    console.log(`JXL WASM Tier: ${tier}`);

    console.log("\n--- Medium Thumbnail (Single-shot) ---");
    await processThumb('medium-thumb-fast.jpg', 'medium-thumb-oneshot.jxl');

    console.log("\n--- Small Thumbnail (Single-shot) ---");
    await processThumb('absolute-smallest-thumb.jpg', 'small-thumb-oneshot.jxl');

    console.log("\nAll done.");
    process.exit(0);
}

main().catch(console.error);