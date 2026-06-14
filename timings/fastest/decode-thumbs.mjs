import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createDecoder, detectTier, setForcedTier } from '../../packages/jxl-wasm/dist/index.js';
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

function exactBuffer(view) {
    if (view instanceof ArrayBuffer) return view;
    if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view.buffer;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

async function decodeThumb(filename) {
    const t0 = performance.now();
    console.log(`\nDecoding ${filename}...`);

    const jxlBytes = await readFile(filename);
    stamp(t0, `Read ${jxlBytes.byteLength} bytes`);

    const decoder = createDecoder({
        format: 'rgba8',
        progressionTarget: 'final',
        emitEveryPass: false,
        downsample: 1,
    });

    let width = 0;
    let height = 0;

    const evTask = (async () => {
        for await (const ev of decoder.events()) {
            if (ev.type === 'error') {
                throw new Error(`${ev.code}: ${ev.message}`);
            }
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
    stamp(t0, `Decoded RGBA (${width}x${height}) in ${decodeMs.toFixed(2)} ms`);
    
    await decoder.dispose();
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

    await decodeThumb('medium-thumb.jxl');
    await decodeThumb('small-thumb.jxl');

    console.log("\nAll done.");
    process.exit(0);
}

main().catch(console.error);