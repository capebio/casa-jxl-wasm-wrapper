import { open, writeFile } from 'node:fs/promises';
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

const ORF_PATH = String.raw`c:\995\2026-02-20 Gobabeb To Windhoek\P2200476 Pogonospermum cleomoides.ORF`;

async function main() {
    if (typeof globalThis.Worker === 'undefined') {
        globalThis.Worker = BrowserLikeWorker;
        globalThis.navigator ??= {};
        globalThis.navigator.hardwareConcurrency ??= 8;
    }

    const tTotal0 = performance.now();
    const fh = await open(ORF_PATH, 'r');
    let mediumJpeg;
    try {
        const buf = Buffer.allocUnsafe(2 * 1024 * 1024);
        await fh.read(buf, 0, buf.length, 0);
        const SOI = Buffer.from([0xFF, 0xD8, 0xFF]);
        const EOI = Buffer.from([0xFF, 0xD9]);
        const start = buf.indexOf(SOI, 0);
        const next = buf.indexOf(SOI, start + 3); // Skip tiny one
        const end = buf.indexOf(EOI, next);
        mediumJpeg = buf.subarray(next, end + 2);
    } finally {
        await fh.close();
    }

    console.log(`Extracted Medium JPEG: ${mediumJpeg.length} bytes`);

    // 1. Decode & Downscale (1/2 width)
    const t0 = performance.now();
    const { data: rgba, info } = await sharp(mediumJpeg)
        .resize({ width: 1600 }) 
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    const scaleMs = performance.now() - t0;
    console.log(`Sharp Downscale (3200->1600): ${scaleMs.toFixed(2)} ms`);

    // 2. Encode to JXL (Effort 1)
    const t1 = performance.now();
    const encoder = createEncoder({
        format: 'rgba8',
        width: info.width,
        height: info.height,
        effort: 1,
        quality: 75,
        progressive: false,
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

    const encodeMs = performance.now() - t1;
    console.log(`JXL Encode (Effort 1, MT): ${encodeMs.toFixed(2)} ms`);

    const jxlBytes = Buffer.concat(chunks.map(c => Buffer.from(c)));
    await writeFile('inbetween-thumbnail.jxl', jxlBytes);
    
    const totalMs = performance.now() - tTotal0;
    console.log(`\nResult: inbetween-thumbnail.jxl (${jxlBytes.length} bytes)`);
    console.log(`Total Pipeline Time: ${totalMs.toFixed(2)} ms`);

    process.exit(0);
}

main().catch(console.error);