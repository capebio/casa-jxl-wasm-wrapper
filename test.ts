// Smoke-test the wasm crate end-to-end against the same ORF the native pipeline uses.
// Does not exercise jSquash JXL encode — that runs only in the browser path.

import init, { process_orf } from "./pkg/raw_converter_wasm.js";
import { readFileSync } from "node:fs";

const ORF = String.raw`c:\995\2026-01-09 Birthday at Cederberg\P1100085.ORF`;

const wasmBytes = readFileSync(
    new URL("./pkg/raw_converter_wasm_bg.wasm", import.meta.url),
);
await init({ module_or_path: wasmBytes });

const t0 = performance.now();
const data = readFileSync(ORF);
const readMs = performance.now() - t0;

const t1 = performance.now();
const result = process_orf(
    new Uint8Array(data),
    /* exposure_ev */ 0,
    /* contrast    */ 0,
    /* highlights  */ 0,
    /* shadows     */ 0,
    /* whites      */ 0,
    /* blacks      */ 0,
    /* saturation  */ 0,
    /* vibrance    */ 0,
    /* temp        */ 0,
    /* tint        */ 0,
    /* wb_r_override */ NaN,
    /* wb_b_override */ NaN,
    /* texture     */ 0,
    /* clarity     */ 0,
);
const totalMs = performance.now() - t1;

console.log(`read ORF       : ${readMs.toFixed(1)} ms (${data.length} bytes)`);
console.log(`process_orf    : ${totalMs.toFixed(1)} ms`);
console.log(`  decompress   : ${result.decompress_ms.toFixed(1)} ms`);
console.log(`  demosaic     : ${result.demosaic_ms.toFixed(1)} ms`);
console.log(`  tonemap      : ${result.tonemap_ms.toFixed(1)} ms`);
console.log(`  orient       : ${result.orient_ms.toFixed(1)} ms`);
console.log(`dims           : ${result.width} × ${result.height}`);
console.log(`orientation    : ${result.orientation}`);

const rgb = result.take_rgb();
console.log(`rgb buffer     : ${rgb.length} bytes (${(rgb.length / 1024 / 1024).toFixed(1)} MB)`);
console.log(`first 9 bytes  :`, [...rgb.slice(0, 9)]);
