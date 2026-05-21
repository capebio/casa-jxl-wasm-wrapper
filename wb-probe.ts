// Dump wb_mode + camera WB_r/b + auto-WB gray-world WB_r/b for each ORF.

import init, { process_orf } from "./pkg/raw_converter_wasm.js";
import { readFileSync } from "node:fs";

const wasmBytes = readFileSync(
    new URL("./pkg/raw_converter_wasm_bg.wasm", import.meta.url),
);
await init({ module_or_path: wasmBytes });

const files = process.argv.slice(2);
console.log('file                     | wb_mode | from_cam | wb_r  wb_b | matrix');
console.log('-'.repeat(90));

for (const f of files) {
    try {
        const raw = new Uint8Array(readFileSync(f));
        const r = process_orf(raw, 0,0,0,0,0,0,0,0,0,0, NaN, NaN, 0, 0);
        const name = f.split(/[\\/]/).pop()!.padEnd(24);
        console.log(`${name} | ${String(r.wb_mode).padStart(7)} | ${String(r.wb_from_camera).padStart(8)} | ${r.wb_r_used.toFixed(3)} ${r.wb_b_used.toFixed(3)} | ${r.color_matrix_from_mn ? 'mn' : 'fallback'}`);
    } catch (e) {
        console.log(`${f}: ${(e as Error).message}`);
    }
}
