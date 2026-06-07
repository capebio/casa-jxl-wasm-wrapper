import { expect, test } from 'bun:test';
import { createDecoder, createEncoder, setJxlModuleFactoryForTesting } from '../src/index';

test('Sneyers progressive settings emit multiple visible non-final passes', async () => {
  setJxlModuleFactoryForTesting(loadPreferredLibjxlModuleForTest);

  const width = 512;
  const height = 512;
  const pixels = makeStructuredNoisePixels(width, height);
  const encoder = createEncoder({
    format: 'rgba8',
    width,
    height,
    hasAlpha: true,
    iccProfile: null,
    exif: null,
    xmp: null,
    distance: null,
    quality: 80,
    effort: 3,
    progressive: true,
    progressiveFlavor: 'ac',
    previewFirst: true,
    progressiveDc: 2,
    progressiveAc: 1,
    qProgressiveAc: 1,
    chunked: false,
    groupOrder: 1,
  });
  encoder.pushPixels(pixels);
  encoder.finish();

  const encoded = concatUint8(await collectChunks(encoder.chunks()));
  await encoder.dispose();
  expect(encoded.byteLength).toBeGreaterThan(0);

  const decoder = createDecoder({
    format: 'rgba8',
    region: null,
    downsample: 1,
    progressionTarget: 'final',
    emitEveryPass: true,
    progressiveDetail: 'passes',
    preserveIcc: false,
    preserveMetadata: false,
  });
  const progressHashes = new Set<number>();
  let progressEvents = 0;
  let finalSeen = false;
  const eventTask = (async () => {
    for await (const ev of decoder.events()) {
      if (ev.type === 'error') throw new Error(ev.message);
      if (ev.type === 'progress') {
        progressEvents++;
        progressHashes.add(hashPixels(ev.pixels));
      }
      if (ev.type === 'final') finalSeen = true;
    }
  })();

  await feedChunksWithYields(decoder, encoded, 2048);
  await eventTask;
  await decoder.dispose();

  expect(finalSeen).toBe(true);
  expect(progressEvents).toBeGreaterThan(1);
  expect(progressHashes.size).toBeGreaterThan(1);
}, 30000);

function makeStructuredNoisePixels(width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  let state = 0x9e3779b9 >>> 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      state = (state * 1664525 + 1013904223) >>> 0;
      const noise = (state >>> 24) & 0xff;
      out[i + 0] = (x * 3 + noise) & 0xff;
      out[i + 1] = (y * 5 + (noise >>> 1)) & 0xff;
      out[i + 2] = ((x ^ y) * 7 + (noise >>> 2)) & 0xff;
      out[i + 3] = 0xff;
    }
  }
  return out;
}

async function collectChunks(chunks: AsyncIterable<Uint8Array | ArrayBuffer>): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for await (const chunk of chunks) {
    out.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
  }
  return out;
}

function concatUint8(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function hashPixels(pixels: ArrayBuffer | Uint8Array): number {
  const data = pixels instanceof Uint8Array ? pixels : new Uint8Array(pixels);
  let hash = 0x811c9dc5;
  for (let i = 0; i < data.byteLength; i++) {
    hash ^= data[i]!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

async function feedChunksWithYields(
  decoder: ReturnType<typeof createDecoder>,
  encoded: Uint8Array,
  chunkSize: number,
) {
  for (let offset = 0; offset < encoded.byteLength; offset += chunkSize) {
    decoder.push(encoded.subarray(offset, Math.min(encoded.byteLength, offset + chunkSize)));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  decoder.close();
}

async function loadPreferredLibjxlModuleForTest() {
  const imported = await import('../dist/jxl-core.scalar.js');
  const factory = imported.default as (cfg: { locateFile: (p: string) => string }) => Promise<unknown>;
  const baseUrl = new URL('../dist/', import.meta.url);
  return await factory({ locateFile: (path: string) => new URL(path, baseUrl).href }) as never;
}
