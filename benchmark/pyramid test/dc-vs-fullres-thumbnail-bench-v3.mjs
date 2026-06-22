#!/usr/bin/env node
/**
 * DC-progressive vs full-res thumbnail extraction (v3 - batch downscale).
 *
 * Realistic workflow:
 * 1. Encode image to JXL (one-time)
 * 2. Decode DC frame once
 * 3. Downscale that frame to all target sizes (batched)
 * vs
 * 1. Encode image to JXL (one-time)
 * 2. Decode full-res frame once
 * 3. Downscale that frame to all target sizes (batched)
 *
 * Reports: encode cost + single-decode + batch-downscale time.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';

import { createEncoder, createDecoder } from '../../packages/jxl-wasm/dist/index.js';

const CORPUS_ROOT = String.raw`C:\Foo\raw-converter\tests\fractal_gen`;
const OUTPUT_DIR = String.raw`C:\Foo\raw-converter-wasm\docs\outputs\timing tests`;
const TARGET_SIZES = [1024, 512, 256, 64];
const MIN_IMAGE_SIZE = 4096;
const QUALITY = 80;
const EFFORT = 3;

function bytesFrom(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

async function loadTiff(path) {
  const buf = readFileSync(path);
  const meta = await sharp(buf).metadata();
  return { buf, meta };
}

async function tiffToRgba8(buf, width, height) {
  const result = await sharp(buf)
    .resize(width, height, { fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const rgb = result.data;
  const actualWidth = result.info.width;
  const actualHeight = result.info.height;

  const rgbaData = new Uint8Array(actualWidth * actualHeight * 4);
  for (let i = 0; i < rgb.length; i += 3) {
    const idx = (i / 3) * 4;
    rgbaData[idx] = rgb[i];
    rgbaData[idx + 1] = rgb[i + 1];
    rgbaData[idx + 2] = rgb[i + 2];
    rgbaData[idx + 3] = 255;
  }
  return { rgba: rgbaData, width: actualWidth, height: actualHeight };
}

async function encodeJxl(rgba, width, height, options = {}) {
  const chunks = [];
  const encoder = createEncoder({
    format: 'rgba8',
    width,
    height,
    hasAlpha: false,
    iccProfile: null,
    exif: null,
    xmp: null,
    distance: 1.0,
    quality: options.quality ?? QUALITY,
    effort: options.effort ?? EFFORT,
    progressive: options.progressive ?? false,
    progressiveFlavor: options.progressiveFlavor ?? undefined,
    progressiveDc: options.progressiveDc ?? 0,
    modular: -1,
    ...options,
  });

  const chunkTask = (async () => {
    for await (const chunk of encoder.chunks()) {
      chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    }
  })();

  await encoder.pushPixels(rgba);
  await encoder.finish();
  await chunkTask;
  await encoder.dispose();

  const total = chunks.reduce((s, c) => s + c.byteLength, 0);
  const jxl = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    jxl.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return jxl;
}

async function decodeFull(jxl, fullWidth, fullHeight) {
  // Decode full-res once (no downsampling, we'll downscale after)
  const decoder = createDecoder({
    format: 'rgba8',
    progressionTarget: 'final',
    downsample: 1,
    emitEveryPass: false,
    preserveIcc: false,
    preserveMetadata: false,
  });

  decoder.push(jxl);
  decoder.close();

  const timeStart = performance.now();
  let frame = null;

  for await (const event of decoder.events()) {
    if (event.type === 'final') {
      frame = event;
      break;
    }
    if (event.type === 'error') throw new Error(`Decode error: ${event.message}`);
  }

  const decodeMs = performance.now() - timeStart;
  await decoder.dispose();

  if (!frame || !frame.pixels) throw new Error('No frame decoded');
  return { pixels: frame.pixels, width: frame.info.width, height: frame.info.height, decodeMs };
}

async function decodeDc(jxl, fullWidth, fullHeight) {
  // Decode DC frame once (no downsampling, we'll downscale after)
  const decoder = createDecoder({
    format: 'rgba8',
    progressionTarget: 'dc',
    progressiveDetail: 'dc',
    downsample: 1,
    emitEveryPass: false,
    preserveIcc: false,
    preserveMetadata: false,
  });

  decoder.push(jxl);
  decoder.close();

  const timeStart = performance.now();
  let frame = null;

  for await (const event of decoder.events()) {
    if (event.type === 'preview' || event.type === 'progress' || event.type === 'final') {
      frame = event;
    }
    if (event.type === 'final') break;
    if (event.type === 'error') throw new Error(`Decode error: ${event.message}`);
  }

  const decodeMs = performance.now() - timeStart;
  await decoder.dispose();

  if (!frame || !frame.pixels) throw new Error('No DC frame decoded');
  return { pixels: frame.pixels, width: frame.info.width, height: frame.info.height, decodeMs };
}

async function downscaleFrame(pixelBuffer, width, height, targets) {
  // Downscale one frame to multiple target sizes
  const timeStart = performance.now();
  const results = {};

  for (const targetSize of targets) {
    await sharp(pixelBuffer, { raw: { width, height, channels: 4 } })
      .resize(targetSize, targetSize, { fit: 'inside', withoutEnlargement: true })
      .toBuffer();
  }

  const downscaleMs = performance.now() - timeStart;
  return { downscaleMs };
}

async function runBench() {
  const files = readdirSync(CORPUS_ROOT)
    .filter(f => f.endsWith('.tif') || f.endsWith('.tiff'))
    .sort();

  const testFiles = [];
  for (const file of files) {
    const path = join(CORPUS_ROOT, file);
    const { meta } = await loadTiff(path);
    const maxDim = Math.max(meta.width, meta.height);
    if (maxDim >= MIN_IMAGE_SIZE && maxDim <= 8192) {
      testFiles.push({ file, path, ...meta });
    }
  }

  if (!testFiles.length) {
    console.error(`No TIFFs ≥${MIN_IMAGE_SIZE}px found in ${CORPUS_ROOT}`);
    process.exit(1);
  }

  console.log(`Found ${testFiles.length} test files ≥${MIN_IMAGE_SIZE}px`);
  console.log(`Targets: ${TARGET_SIZES.join(', ')} pixels\n`);

  const results = {
    timestamp: new Date().toISOString(),
    targetSizes: TARGET_SIZES,
    files: [],
  };

  let totalEncode = 0, totalDcDecode = 0, totalDcDownscale = 0;
  let totalFrDecode = 0, totalFrDownscale = 0;

  for (const testFile of testFiles) {
    const { file, path, width, height } = testFile;
    console.log(`${file} (${width}×${height})`);

    const { buf: tiffBuf } = await loadTiff(path);
    const { rgba, width: rgbaWidth, height: rgbaHeight } = await tiffToRgba8(tiffBuf, width, height);

    // Encode once
    const encStart = performance.now();
    const jxlDc = await encodeJxl(rgba, rgbaWidth, rgbaHeight, {
      progressive: true,
      progressiveDc: 1,
    });
    const jxlFull = await encodeJxl(rgba, rgbaWidth, rgbaHeight, {
      progressive: false,
      progressiveDc: 0,
    });
    const encodeMs = performance.now() - encStart;
    totalEncode += encodeMs;

    // Decode DC once + downscale all
    const dcDecoded = await decodeDc(jxlDc, rgbaWidth, rgbaHeight);
    totalDcDecode += dcDecoded.decodeMs;
    const dcDownscale = await downscaleFrame(dcDecoded.pixels, dcDecoded.width, dcDecoded.height, TARGET_SIZES);
    totalDcDownscale += dcDownscale.downscaleMs;

    // Decode full-res once + downscale all
    const frDecoded = await decodeFull(jxlFull, rgbaWidth, rgbaHeight);
    totalFrDecode += frDecoded.decodeMs;
    const frDownscale = await downscaleFrame(frDecoded.pixels, frDecoded.width, frDecoded.height, TARGET_SIZES);
    totalFrDownscale += frDownscale.downscaleMs;

    const dcTotal = dcDecoded.decodeMs + dcDownscale.downscaleMs;
    const frTotal = frDecoded.decodeMs + frDownscale.downscaleMs;

    console.log(`  Encode: ${encodeMs.toFixed(0)}ms`);
    console.log(`  DC: decode=${dcDecoded.decodeMs.toFixed(0)}ms + downscale=${dcDownscale.downscaleMs.toFixed(0)}ms = ${dcTotal.toFixed(0)}ms`);
    console.log(`  FR: decode=${frDecoded.decodeMs.toFixed(0)}ms + downscale=${frDownscale.downscaleMs.toFixed(0)}ms = ${frTotal.toFixed(0)}ms`);
    console.log(`  Speedup: ${(frTotal / dcTotal).toFixed(2)}x\n`);

    results.files.push({
      file,
      width,
      height,
      jxlDcSize: jxlDc.length,
      jxlFullSize: jxlFull.length,
      encodeMs: encodeMs.toFixed(2),
      dcDecodeMs: dcDecoded.decodeMs.toFixed(2),
      dcDownscaleMs: dcDownscale.downscaleMs.toFixed(2),
      dcTotalMs: dcTotal.toFixed(2),
      frDecodeMs: frDecoded.decodeMs.toFixed(2),
      frDownscaleMs: frDownscale.downscaleMs.toFixed(2),
      frTotalMs: frTotal.toFixed(2),
    });
  }

  const avgFiles = testFiles.length;
  const dcTotalPerFile = (totalDcDecode + totalDcDownscale) / avgFiles;
  const frTotalPerFile = (totalFrDecode + totalFrDownscale) / avgFiles;

  console.log('=== SUMMARY (per file) ===');
  console.log(`Encode (one-time): ${(totalEncode / avgFiles).toFixed(0)}ms`);
  console.log(`\nThumbnail extraction (decode-once + downscale-all):`);
  console.log(`  DC: ${(totalDcDecode / avgFiles).toFixed(0)}ms decode + ${(totalDcDownscale / avgFiles).toFixed(0)}ms downscale = ${dcTotalPerFile.toFixed(0)}ms`);
  console.log(`  FR: ${(totalFrDecode / avgFiles).toFixed(0)}ms decode + ${(totalFrDownscale / avgFiles).toFixed(0)}ms downscale = ${frTotalPerFile.toFixed(0)}ms`);
  console.log(`\nSpeedup: ${(frTotalPerFile / dcTotalPerFile).toFixed(2)}x`);
  console.log(`Combined (encode + extraction): DC=${((totalEncode / avgFiles) + dcTotalPerFile).toFixed(0)}ms | FR=${((totalEncode / avgFiles) + frTotalPerFile).toFixed(0)}ms`);

  results.summary = {
    filesCount: testFiles.length,
    encodePerFileMs: (totalEncode / avgFiles).toFixed(2),
    dcDecodePerFileMs: (totalDcDecode / avgFiles).toFixed(2),
    dcDownscalePerFileMs: (totalDcDownscale / avgFiles).toFixed(2),
    dcTotalPerFileMs: dcTotalPerFile.toFixed(2),
    frDecodePerFileMs: (totalFrDecode / avgFiles).toFixed(2),
    frDownscalePerFileMs: (totalFrDownscale / avgFiles).toFixed(2),
    frTotalPerFileMs: frTotalPerFile.toFixed(2),
    speedup: (frTotalPerFile / dcTotalPerFile).toFixed(2),
  };

  const outPath = join(OUTPUT_DIR, `dc-vs-fullres-batch-downscale-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nResults: ${outPath}`);
}

runBench().catch(e => {
  console.error('Benchmark failed:', e);
  process.exit(1);
});
