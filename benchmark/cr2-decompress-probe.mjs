// Confirm CR2 decompress_ms now reports LJPEG-entropy-only (apples-to-apples with ORF),
// not the whole decode_bytes wall (parse + slice-reassembly + crop). Decodes real files
// a few times and prints median per-phase ms from the rebuilt pkg.
import initRaw, { process_cr2_with_flags, process_orf_with_flags } from "../pkg/raw_converter_wasm.js";
import { readFileSync, existsSync } from "node:fs";

await initRaw({ module_or_path: readFileSync(new URL("../pkg/raw_converter_wasm_bg.wasm", import.meta.url)) });

const ARGS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Number.NaN, Number.NaN, 0, 0];
const FULL = 1;
const median = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];

const files = [
  ["CR2", String.raw`C:\Foo\raw-converter\tests\_MG_1750.CR2`, process_cr2_with_flags],
  ["CR2", String.raw`C:\Foo\raw-converter\tests\ADH 1248.CR2`, process_cr2_with_flags],
  ["ORF", String.raw`C:\Foo\raw-converter\tests\P1110226.ORF`, process_orf_with_flags],
];

for (const [kind, path, fn] of files) {
  if (!existsSync(path)) { console.log(`skip (missing): ${path}`); continue; }
  const raw = new Uint8Array(readFileSync(path));
  const dec = [], dem = [], ton = [];
  for (let i = 0; i < 5; i++) {
    const r = fn(raw, FULL, ...ARGS);
    dec.push(r.decompress_ms ?? 0);
    dem.push(r.demosaic_ms ?? 0);
    ton.push(r.tonemap_ms ?? 0);
    r.free?.();
  }
  console.log(`${kind} ${path.split("\\").pop().padEnd(16)} decompress_ms=${median(dec).toFixed(1)}  demosaic_ms=${median(dem).toFixed(1)}  tonemap_ms=${median(ton).toFixed(1)}`);
}
