// gen-gradient-alpha.mjs — write a PAM (RGBA) with a horizontal alpha gradient
// (0..255 across x) and noise RGB (high entropy → multiple AC passes). Used to
// test that alpha decodes to a VALID partial state at progressive pauses.
//   bun tools/gen-gradient-alpha.mjs <out.pam> [size]
import { writeFileSync } from 'node:fs';

const out = process.argv[2] ?? 'gradient_alpha.pam';
const N = Number(process.argv[3] ?? 512);
const header = Buffer.from(
  `P7\nWIDTH ${N}\nHEIGHT ${N}\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n`,
  'ascii',
);
const px = Buffer.alloc(N * N * 4);
let s = 0x12345678 >>> 0;
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    s = (s * 1103515245 + 12345) >>> 0;
    const i = (y * N + x) * 4;
    px[i] = (s >>> 16) & 0xff;
    px[i + 1] = (s >>> 8) & 0xff;
    px[i + 2] = s & 0xff;
    px[i + 3] = Math.round((x / (N - 1)) * 255); // alpha gradient 0..255
  }
}
writeFileSync(out, Buffer.concat([header, px]));
console.log(`wrote ${out} (${N}x${N} RGBA, alpha gradient 0..255)`);
