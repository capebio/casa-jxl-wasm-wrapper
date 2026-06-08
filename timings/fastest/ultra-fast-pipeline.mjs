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

async function fastExtractMediumJpeg(fh) {
    const t0 = performance.now();
    // Read only the first 128KB. The medium thumbnail header is at ~19KB.
    const buf = Buffer.allocUnsafe(128 * 1024);
    await fh.read(buf, 0, 128 * 1024, 0);
    stamp(t0, `Read first 128KB`);

    const SOI = Buffer.from([0xFF, 0xD8, 0xFF]);
    const EOI = Buffer.from([0xFF, 0xD9]);
    
    let pos = 0;
    const jpegs = [];
    while ((pos = buf.indexOf(SOI, pos)) !== -1) {
        const end = buf.indexOf(EOI, pos);
        // If we found the start but not the end in the first 128KB, 
        // we need to look further (but only for the end).
        let jpeg;
        if (end !== -1) {
            jpeg = buf.subarray(pos, end + 2);
        } else {
            // Found a JPEG start that extends beyond 128KB.
            // This is our medium thumbnail! (It's ~957KB).
            // We just need to read its length from the TIFF IFD or scan for EOI.
            // For now, let's just read enough to cover it.
            const bigBuf = Buffer.allocUnsafe(2 * 1024 * 1024);
            await fh.read(bigBuf, 0, bigBuf.length, 0);
            const realEnd = bigBuf.indexOf(EOI, pos);
            jpeg = bigBuf.subarray(pos, realEnd + 2);
        }
        jpegs.push(jpeg);
        pos += 3;
    }

    // Return the largest JPEG found (the medium preview)
    jpegs.sort((a, b) => b.length - a.length);
    stamp(t0, `Located Medium JPEG (${jpegs[0].length} bytes)`);
    return jpegs[0];
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
        // 1. FAST EXTRACTION
        const mediumJpeg = await fastExtractMediumJpeg(fh);
        
        // 2. LOSSLESS TRANSCODE
        console.log(`\nTranscoding Medium JPEG to JXL...`);
        const t0 = performance.now();
        const jxlBytes = await transcodeJpegToJxl(mediumJpeg);
        console.log(`  -> Transcoded in ${stamp(t0, "WASM Work")} ms`);
        
        await writeFile('medium-thumb-transcoded.jxl', jxlBytes);
        console.log(`  -> Wrote medium-thumb-transcoded.jxl`);
    } finally {
        await fh.close();
    }

    stamp(tTotal0, "Total end-to-end Pipeline Time");
    process.exit(0);
}

main().catch(console.error);