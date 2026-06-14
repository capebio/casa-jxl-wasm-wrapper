import { readFileSync } from 'fs';
import { Worker as NodeWorker } from 'worker_threads';

class BrowserLikeWorker {
  #worker;
  #onmessage = null;
  #onerror = null;

  constructor(url, options = {}) {
    const workerUrl = url instanceof URL ? url.href : String(url);
    this.#worker = new NodeWorker(new URL('./jxl-worker-shim.mjs', import.meta.url), {
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
globalThis.Worker = BrowserLikeWorker;

import initRaw, { process_orf, rgb_to_rgba, downscale_rgba } from './pkg/raw_converter_wasm.js';
import { createEncoder, createDecoder } from '@casabio/jxl-wasm';
import { computePsnrVsFinal, computeSsimVsFinal } from './web/jxl-progressive-quality.js';
import { pixelsToXyb, computeButteraugliVsFinal } from './web/jxl-butteraugli.js';
import { createSneyersPreset } from './web/jxl-progressive-best-preset.js';

async function main() {
    console.log("Loading WASM...");
    const wasmBytes = readFileSync('./pkg/raw_converter_wasm_bg.wasm');
    await initRaw(wasmBytes);

    const filePath = "C:\\995\\2026-02-20 Gobabeb To Windhoek\\P2200476 Pogonospermum cleomoides.ORF";
    console.log(`Reading ${filePath}...`);
    const rawBytes = readFileSync(filePath);

    console.log("Processing RAW...");
    const result = process_orf(rawBytes, 0.3, 0.1, 0, 0, 0, 0, 0.15, 0.1, 0, 0, NaN, NaN, 0, 0);
    const rgba = rgb_to_rgba(result.take_rgb());
    const sourceWidth = result.width;
    const sourceHeight = result.height;
    result.free();

    const targetLongEdge = 1920;
    const sourceLong = Math.max(sourceWidth, sourceHeight);
    const scale = targetLongEdge / sourceLong;
    const targetWidth = Math.round(sourceWidth * scale);
    const targetHeight = Math.round(sourceHeight * scale);

    console.log(`Downscaling from ${sourceWidth}x${sourceHeight} to ${targetWidth}x${targetHeight}...`);
    let targetRgba = rgba;
    if (downscale_rgba) {
         targetRgba = downscale_rgba(rgba, sourceWidth, sourceHeight, targetWidth, targetHeight);
    } else {
         throw new Error("downscale_rgba not found in wasm");
    }

    console.log("Encoding...");
    const quality = 85;
    const preset = createSneyersPreset({
        width: targetWidth,
        height: targetHeight,
        targetLongEdge: 'full',
        quality,
        hasAlpha: true,
        progressiveDetail: 'passes'
    });

    const encoder = createEncoder({
        ...preset.encode,
        width: targetWidth,
        height: targetHeight,
        quality,
        progressiveDc: 0,
        progressiveAc: 2,
        qProgressiveAc: 2,
        progressiveDetail: undefined,
        buffering: { strategy: 0 },
        chunked: false,
    });

    const chunks = [];
    const chunkTask = (async () => {
        for await (const chunk of encoder.chunks()) {
            chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
        }
    })();
    await encoder.pushPixels(targetRgba.buffer.slice(targetRgba.byteOffset, targetRgba.byteOffset + targetRgba.byteLength));
    await encoder.finish();
    await chunkTask;
    await encoder.dispose();

    const views = chunks.map(chunk => chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    const total = views.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const jxlBytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of views) {
        jxlBytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    console.log(`Encoded ${jxlBytes.byteLength} bytes.`);

    console.log("Decoding progressively...");
    const decoder = createDecoder({
        format: 'rgba8',
        region: null,
        downsample: 1,
        progressionTarget: 'final',
        emitEveryPass: true,
        progressiveDetail: 'passes',
        preserveIcc: false,
        preserveMetadata: false,
    });

    const passes = [];
    const eventTask = (async () => {
        for await (const event of decoder.events()) {
            if (event.type === 'progress' || event.type === 'final') {
                passes.push({
                    pass: passes.length + 1,
                    isFinal: event.type === 'final',
                    pixels: new Uint8Array(event.pixels)
                });
            }
        }
    })();

    await decoder.push(jxlBytes.buffer.slice(jxlBytes.byteOffset, jxlBytes.byteOffset + jxlBytes.byteLength));
    await decoder.close();
    await eventTask;
    await decoder.dispose();

    console.log(`Decoded ${passes.length} passes. Now running metrics...`);

    const finalPixels = targetRgba; 

    // PSNR — progressive frames vs lossless master (pre-encode source)
    const PSNR_PASS3_MIN_DB = 40;
    console.log("\\n--- PSNR ---");
    let totalPsnrTime = 0;
    const psnrByPass = [];
    for (const p of passes) {
        const start = performance.now();
        const score = computePsnrVsFinal(finalPixels, p.pixels);
        const t = performance.now() - start;
        totalPsnrTime += t;
        psnrByPass.push({ pass: p.pass, psnr: score });
        console.log(`Pass ${p.pass}${p.isFinal ? ' (final)' : ''}: ${t.toFixed(2)} ms (Score: ${score.toFixed(2)} dB)`);
    }
    console.log(`Total PSNR time: ${totalPsnrTime.toFixed(2)} ms`);

    const pass3 = psnrByPass.find((entry) => entry.pass === 3);
    if (!pass3) {
        throw new Error(
            `PSNR regression gate: expected pass 3 in progressive decode, got ${passes.length} pass(es)`
        );
    }
    if (!Number.isFinite(pass3.psnr) || pass3.psnr < PSNR_PASS3_MIN_DB) {
        throw new Error(
            `PSNR regression gate: pass 3 ${pass3.psnr.toFixed(2)} dB < ${PSNR_PASS3_MIN_DB} dB vs lossless master`
        );
    }
    console.log(
        `\\n--- PSNR Regression Gate ---\\n` +
        `Pass 3 vs lossless master: ${pass3.psnr.toFixed(2)} dB (>= ${PSNR_PASS3_MIN_DB} dB) OK`
    );

    // SSIM
    console.log("\\n--- SSIM ---");
    let totalSsimTime = 0;
    for (const p of passes) {
        const start = performance.now();
        const score = computeSsimVsFinal(finalPixels, p.pixels, targetWidth, targetHeight);
        const t = performance.now() - start;
        totalSsimTime += t;
        console.log(`Pass ${p.pass}${p.isFinal ? ' (final)' : ''}: ${t.toFixed(2)} ms (Score: ${score.toFixed(3)})`);
    }
    console.log(`Total SSIM time: ${totalSsimTime.toFixed(2)} ms`);

    // Butteraugli
    console.log("\\n--- Butteraugli ---");
    let totalButtTime = 0;
    
    // Precompute refXyb
    const startPre = performance.now();
    const refXyb = pixelsToXyb(finalPixels, targetWidth * targetHeight);
    const preTime = performance.now() - startPre;
    console.log(`Precompute pixelsToXyb: ${preTime.toFixed(2)} ms`);

    for (const p of passes) {
        const start = performance.now();
        const score = computeButteraugliVsFinal(refXyb, p.pixels, targetWidth, targetHeight);
        const t = performance.now() - start;
        totalButtTime += t;
        console.log(`Pass ${p.pass}${p.isFinal ? ' (final)' : ''}: ${t.toFixed(2)} ms (Score: ${score.toFixed(3)})`);
    }
    console.log(`Total per-pass Butteraugli time: ${totalButtTime.toFixed(2)} ms`);
    console.log(`Grand total Butteraugli time (with precompute): ${(totalButtTime + preTime).toFixed(2)} ms`);

    const grandTotal = totalPsnrTime + totalSsimTime + totalButtTime + preTime;
    console.log(`\\nTotal metric compute time: ${grandTotal.toFixed(2)} ms (Node, full-res, synchronous — browser runs these in jxl-frame-stats-worker at <=1MP; NOT a UI-thread measurement)`);
}

main().catch(console.error);
