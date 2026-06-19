// Confirm the lightbox/thumb downscale snap fires end-to-end on a real ORF and that
// preview_downscale_ms drops. Flags = OUT_LIGHTBOX|OUT_THUMB (proxies only).
import initRaw, { process_orf_with_flags } from "../pkg/raw_converter_wasm.js";
import { readFileSync, existsSync } from "node:fs";

await initRaw({ module_or_path: readFileSync(new URL("../pkg/raw_converter_wasm_bg.wasm", import.meta.url)) });

const ARGS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Number.NaN, Number.NaN, 0, 0];
const FLAGS = 2 | 4; // OUT_LIGHTBOX | OUT_THUMB
const median = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];

const path = String.raw`C:\Foo\raw-converter\tests\P1110226.ORF`;
if (!existsSync(path)) { console.log("missing:", path); process.exit(0); }
const raw = new Uint8Array(readFileSync(path));

const down = [], dem = [];
let lbw, lbh, tw, th;
for (let i = 0; i < 9; i++) {
  const r = process_orf_with_flags(raw, FLAGS, ...ARGS);
  down.push(r.preview_downscale_ms ?? 0);
  dem.push(r.preview_demosaic_ms ?? 0);
  lbw = r.lb_w; lbh = r.lb_h; tw = r.thumb_w; th = r.thumb_h;
  r.free?.();
}
console.log(`P1110226.ORF  lightbox=${lbw}x${lbh}  thumb=${tw}x${th}`);
console.log(`  preview_demosaic_ms=${median(dem).toFixed(1)}  preview_downscale_ms=${median(down).toFixed(1)} (median of 9)`);
console.log(`  lightbox divides source? ${5184 % lbw === 0 || lbw === 1800 ? "(check)" : ""} lb step ~${(/* sensor long */ Math.round(0))}`);
