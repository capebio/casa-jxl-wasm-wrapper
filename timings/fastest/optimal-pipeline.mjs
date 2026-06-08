import { open, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { transcodeJpegToJxl, detectTier, setForcedTier } from '../../packages/jxl-wasm/dist/index.js';
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

function stamp(t0, label) {
    const ms = performance.now() - t0;
    console.log(`[t+${ms.toFixed(2).padStart(8)} ms] ${label}`);
    return ms;
}

async function extractJpegs(fh) {
    const t0 = performance.now();
    const buf = Buffer.allocUnsafe(2 * 1024 * 1024);
    await fh.read(buf, 0, buf.length, 0);
    stamp(t0, `Read first 2MB`);

    const SOI = Buffer.from([0xFF, 0xD8, 0xFF]);
    const EOI = Buffer.from([0xFF, 0xD9]);
    
    let pos = 0;
    const jpegs = [];
    while ((pos = buf.indexOf(SOI, pos)) !== -1) {
        const end = buf.indexOf(EOI, pos);
        if (end !== -1) {
            jpegs.push(buf.subarray(pos, end + 2));
            pos = end + 2;
        } else {
            pos += 3;
        }
    }

    jpegs.sort((a, b) => b.length - a.length);
    // [0] = medium (~957kb), [2] = small (~8kb)
    return { medium: jpegs[0], small: jpegs[2] };
}

async function processThumb(name, jpeg, tTotal0) {
    console.log(`\n--- ${name} Thumbnail ---`);
    console.log(`JPEG size: ${jpeg.length} bytes`);
    const t0 = performance.now();
    const jxlBytes = await transcodeJpegToJxl(jpeg);
    const ms = performance.now() - t0;
    console.log(`Transcode: ${ms.toFixed(2)} ms`);
    
    const outName = `${name.toLowerCase()}-transcoded.jxl`;
    await writeFile(outName, jxlBytes);
    console.log(`Wrote ${outName} (${jxlBytes.byteLength} bytes)`);
    return ms;
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

    const tTotal0 = performance.now();
    const fh = await open(ORF_PATH, 'r');
    try {
        const { medium, small } = await extractJpegs(fh);
        
        await processThumb('Medium', medium, tTotal0);
        await processThumb('Small', small, tTotal0);
        
    } finally {
        await fh.close();
    }

    console.log("\n--- Final Summary ---");
    stamp(tTotal0, "Total End-to-End Execution Time");
    process.exit(0);
}

main().catch(console.error);