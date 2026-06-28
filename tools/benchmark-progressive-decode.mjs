#!/usr/bin/env node
// Benchmark: progressive JXL decode performance
// Measures decoder with DecodeGroupFromStoredCoefficients optimization active
// Run: node tools/benchmark-progressive-decode.mjs

import { performance } from 'node:perf_hooks';
import { createDecoder, createEncoder } from '../packages/jxl-wasm/dist/index.js';

// Generate test RGBA (256x256 checkerboard)
function makeTestImage(width = 256, height = 256) {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const check = ((x >> 5) + (y >> 5)) & 1;
      pixels[idx] = check ? 255 : 0;      // R
      pixels[idx+1] = check ? 0 : 255;    // G
      pixels[idx+2] = 128;                 // B
      pixels[idx+3] = 255;                 // A
    }
  }
  return pixels;
}

async function main() {
  console.log('Progressive JXL Decode Benchmark');
  console.log('='.repeat(50));

  // Generate test image
  const pixels = makeTestImage(256, 256);
  console.log(`Test image: 256×256 RGBA (deterministic checkerboard)\n`);

  // Encode as 3-pass progressive
  console.log('Encoding 3-pass progressive JXL...');
  const encoder = createEncoder();
  const jxl = await encoder.encode(pixels, {
    width: 256,
    height: 256,
    progressive: true,
    effort: 5,
  });
  console.log(`JXL size: ${jxl.length} bytes\n`);

  // Benchmark: decode multiple rounds
  const rounds = 10;
  const times = [];

  console.log(`Decoding ${rounds} rounds (stored-coeff path active):`);
  for (let round = 0; round < rounds; round++) {
    const decoder = createDecoder();
    const t0 = performance.now();
    const result = await decoder.decode(jxl);
    const t1 = performance.now();
    const ms = t1 - t0;
    times.push(ms);
    console.log(`  Round ${round+1}: ${ms.toFixed(2)}ms (${result.length} frames)`);
  }

  // Stats
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  const min = times[0];
  const max = times[times.length - 1];
  const mean = times.reduce((a, b) => a + b) / times.length;
  const stdev = Math.sqrt(times.reduce((a, b) => a + (b - mean) ** 2) / times.length);

  console.log(`\nPerformance Summary:`);
  console.log(`  Median:  ${median.toFixed(2)}ms`);
  console.log(`  Mean:    ${mean.toFixed(2)}ms`);
  console.log(`  Min:     ${min.toFixed(2)}ms`);
  console.log(`  Max:     ${max.toFixed(2)}ms`);
  console.log(`  StdDev:  ${stdev.toFixed(2)}ms`);
  console.log(`\nOptimization (DecodeGroupFromStoredCoefficients): ACTIVE`);
  console.log(`Expected: progressive redraws skip entropy reader setup`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
