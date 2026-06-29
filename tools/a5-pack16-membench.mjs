// a5-pack16-membench.mjs — A/B verify for the A-5 deferred-pack optimisation.
//
// Loads ONE wasm-pack (--target nodejs) build, decodes a real DNG with
// OUT_FULL_RGB8 | OUT_FULL_16, and reports:
//   - peak wasm linear memory right AFTER process_*_with_flags returns
//     (wasm memory is monotonic, so byteLength == high-water reached during the
//     call). OLD packs a 2nd full-res buffer during process; NEW defers it to
//     take_rgb16_full, so NEW's after-process peak should be ~121 MB lower.
//   - FNV-1a hashes of take_rgb() and take_rgb16_full() for OLD-vs-NEW
//     byte-exactness (the lazy pack must produce identical bytes).
//
// Run once per build and diff the JSON:
//   node tools/a5-pack16-membench.mjs <pkgDir> <dngPath> [flags] [texture]
//
// One build per process so the memory figure reflects only this module.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [pkgDir, dngPath, flagsArg, textureArg] = process.argv.slice(2);
if (!pkgDir || !dngPath) {
  console.error('usage: node a5-pack16-membench.mjs <pkgDir> <dngPath> [flags] [texture]');
  process.exit(2);
}
const flags = flagsArg ? Number(flagsArg) : 9; // OUT_FULL_RGB8(1) | OUT_FULL_16(8)
const texture = textureArg ? Number(textureArg) : 0;

function fnv1a(bytes) {
  // 64-bit FNV-1a in BigInt; returns hex. Stable, dependency-free.
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < bytes.length; i++) {
    h = (h ^ BigInt(bytes[i])) & mask;
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, '0');
}

const MB = (b) => +(b / (1024 * 1024)).toFixed(1);

const dng = readFileSync(resolve(dngPath));

// wasm-pack --target nodejs emits CommonJS; import the package main.
const pkgJsonPath = resolve(pkgDir, 'package.json');
const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
const mainJs = resolve(pkgDir, pkgJson.main);
const mod = await import(pathToFileURL(mainJs).href);

const data = new Uint8Array(dng);

// Signature: (data, output_flags, exposure_ev, contrast, highlights, shadows,
//   whites, blacks, saturation, vibrance, temp, tint, wb_r_override,
//   wb_b_override, texture, clarity). Neutral look; wb overrides NaN = use camera.
const before = process.memoryUsage();
const res = mod.process_dng_with_flags(
  data, flags,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  NaN, NaN, texture, 0,
);
// Peak wasm linear memory at the moment process() returns (pre-take).
const afterProcess = process.memoryUsage();

const rgb = res.take_rgb();
const full16 = res.take_rgb16_full();
const afterTakes = process.memoryUsage();

const out = {
  pkg: pkgDir,
  flags,
  texture,
  dims: { w: res.width, h: res.height, full16_w: res.full16_w, full16_h: res.full16_h },
  bytes: { rgb: rgb.length, full16: full16.length },
  hash: { rgb: fnv1a(rgb), full16: fnv1a(full16) },
  mem_MB: {
    arrayBuffers_after_process: MB(afterProcess.arrayBuffers),
    arrayBuffers_after_takes: MB(afterTakes.arrayBuffers),
    external_after_process: MB(afterProcess.external),
    rss_after_process: MB(afterProcess.rss),
    arrayBuffers_baseline: MB(before.arrayBuffers),
  },
};
console.log(JSON.stringify(out));
