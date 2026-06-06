import { computeButteraugli, setForcedTier } from "../packages/jxl-wasm/dist/index.js";
setForcedTier("simd");

// identical images -> distance ~0
const px = new Uint8Array(4 * 4 * 4).fill(128);
const dist = await computeButteraugli(px.buffer, px.buffer, 4, 4);
console.log("identical distance:", dist);
if (dist !== 0 && dist > 0.01) process.exit(1);

// black vs white -> large distance
const black = new Uint8Array(4 * 4 * 4).fill(0);
const white = new Uint8Array(4 * 4 * 4).fill(255);
const dist2 = await computeButteraugli(black.buffer, white.buffer, 4, 4);
console.log("black vs white distance:", dist2);
if (dist2 <= 0) process.exit(1);

console.log("PASS");
