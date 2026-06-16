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

// 1. FAST EXTRACTION (Using Buffer.indexOf which is implemented in C++ internally and takes < 5ms)
async function extractMediumJpeg() {
    const t0 = performance.now();
    console.log(`\nExtracting Medium JPEG from ${ORF_PATH}...`);
    const CHUNK_SIZE = 2 * 1024 * 1024;
    const fh = await open(ORF_PATH, 'r');
    let buf;
    try {
        buf = Buffer.allocUnsafe(CHUNK_SIZE);
        const { bytesRead } = await fh.read(buf, 0, CHUNK_SIZE, 0);
        buf = buf.subarray(0, bytesRead);
    } finally {
        await fh.close();
    }
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

    jpegs.sort((a, b) => b.length - a.length); // Sort descending
    const mediumJpeg = jpegs[0]; // The largest JPEG in the first 2MB is the medium preview
    stamp(t0, `Extracted Medium JPEG (${mediumJpeg.length} bytes)`);
    return mediumJpeg;
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

    // ==========================================
    // 1. EXTRACT
    // ==========================================
    const jpegBytes = await extractMediumJpeg();
    
    // ==========================================
    // 2. LOSSLESS TRANSCODE TO JXL
    // ==========================================
    // This completely bypasses 'sharp' decoding to RGBA!
    // It repackages the JPEG DCT coefficients directly into a JXL container.
    console.log(`\nTranscoding JPEG to JXL...`);
    const tTranscode0 = performance.now();
    
    const jxlBytes = await transcodeJpegToJxl(jpegBytes);
    
    const transcodeMs = performance.now() - tTranscode0;
    console.log(`  -> Transcoded in ${transcodeMs.toFixed(2)} ms (Size: ${jxlBytes.byteLength} bytes)`);
    
    await writeFile('medium-thumb-transcoded.jxl', jxlBytes);
    console.log(`  -> Wrote medium-thumb-transcoded.jxl`);

    console.log("\nAll done.");
    process.exit(0);
}

main().catch(console.error);