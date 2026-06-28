// Decode the StandardMultifile corpus to FULL-RES RGB8 (version-independent RAW
// pipeline) and dump <name>.rgb bins (u32 LE w, u32 LE h, then w*h*3 RGB8) so the
// native libjxl A/B harness can encode+decode identical pixels on 0.11.2 vs 012.
//
// Run: node benchmark/dump-fullres-rgb.mjs
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import sharp from "sharp";
import initRaw, { process_orf_with_flags, process_cr2_with_flags, process_dng_with_flags }
  from "../pkg/raw_converter_wasm.js";

await initRaw({ module_or_path: readFileSync(new URL("../pkg/raw_converter_wasm_bg.wasm", import.meta.url)) });

const TEST_ROOT = String.raw`C:\Foo\raw-converter\tests`;
const GOB_ROOT = String.raw`C:\995\2026-02-20 Gobabeb To Windhoek`;
const OUT = String.raw`C:\Tmp\rcw-rgb`;
mkdirSync(OUT, { recursive: true });

const FILES = [
  join(TEST_ROOT, "small_file.jpg"),
  join(TEST_ROOT, "P1110226 windows.jpg"),
  join(TEST_ROOT, "PXL_20260527_180319603.RAW-02.ORIGINAL.dng"),
  join(TEST_ROOT, "PXL_20260501_093507165.RAW-02.ORIGINAL.dng"),
  join(TEST_ROOT, "P1110226.ORF"),
  join(GOB_ROOT, "P2200474.ORF"),
  join(TEST_ROOT, "_MG_1750.CR2"),
  join(TEST_ROOT, "ADH 1248.CR2"),
];

// full-res RGB only (flag bit 1), no preview/thumb; remaining process args zeroed.
const FULL = 1;
const ARGS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Number.NaN, Number.NaN, 0, 0];

const manifest = [];
for (const path of FILES) {
  if (!existsSync(path)) { console.warn(`skip missing ${path}`); continue; }
  const ext = extname(path).toLowerCase();
  let rgb, w, h;
  try {
    if (ext === ".jpg" || ext === ".jpeg") {
      const { data, info } = await sharp(path).raw().toBuffer({ resolveWithObject: true });
      // sharp raw is RGB (3ch) for jpeg; drop alpha if present
      const ch = info.channels;
      w = info.width; h = info.height;
      if (ch === 3) { rgb = data; }
      else { rgb = Buffer.alloc(w * h * 3); for (let i = 0, s = 0, d = 0; i < w * h; i++, s += ch, d += 3) { rgb[d] = data[s]; rgb[d + 1] = data[s + 1]; rgb[d + 2] = data[s + 2]; } }
    } else {
      const raw = new Uint8Array(readFileSync(path));
      let dec;
      if (ext === ".orf") dec = process_orf_with_flags(raw, FULL, ...ARGS);
      else if (ext === ".cr2") dec = process_cr2_with_flags(raw, FULL, ...ARGS);
      else if (ext === ".dng") dec = process_dng_with_flags(raw, FULL, ...ARGS);
      else { console.warn(`skip unknown ext ${ext}`); continue; }
      rgb = dec.take_rgb(); w = dec.width; h = dec.height; dec.free();
    }
  } catch (e) { console.warn(`FAIL ${basename(path)}: ${e.message}`); continue; }

  const name = basename(path);
  const buf = Buffer.alloc(8 + rgb.length);
  buf.writeUInt32LE(w, 0); buf.writeUInt32LE(h, 4);
  Buffer.from(rgb.buffer, rgb.byteOffset ?? 0, rgb.length).copy(buf, 8);
  const outPath = join(OUT, name + ".rgb");
  writeFileSync(outPath, buf);
  const mp = (w * h / 1e6).toFixed(1);
  console.log(`  ${name}: ${w}x${h} (${mp} MP) -> ${outPath}`);
  manifest.push({ name, w, h, mp: parseFloat(mp), file: outPath });
}
writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`\ndumped ${manifest.length} files -> ${OUT}`);
