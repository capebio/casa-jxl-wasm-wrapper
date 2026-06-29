// Integration flipflop for the C++ progressive ROI crop (jxl_wasm_dec_set_region).
//
// Encodes a JXL with the scalar (monolithic) module, then decodes it with the split
// dec.simd module — the one the app's viewer loads and the one rebuilt with the ROI
// bridge. For each (region, downsample) it asserts the region/downsample decode is
// byte-identical to the JS reference applyRegionAndDownsample applied to a full decode.
//
// Pre-rebuild (symbol absent): the decode takes the JS fallback path — still byte-exact
// vs the same reference, so the test passes (and logs cppRoiAvailable=false). After the
// dec WASM is rebuilt with _jxl_wasm_dec_set_region the very same assertions prove the
// C++ crop matches the JS algorithm bit-for-bit (logs cppRoiAvailable=true).

import { expect, test, afterAll } from 'bun:test';
import { createDecoder, createEncoder, setJxlModuleFactoryForTesting } from '../src/index';
import { applyRegionAndDownsample } from '../src/facade';

type Region = { x: number; y: number; w: number; h: number };

const baseUrl = new URL('../dist/', import.meta.url);
function loadModule(file: string) {
  return async () => {
    const imported = await import(new URL(`../dist/${file}`, import.meta.url).href);
    const factory = imported.default as (cfg: { locateFile: (p: string) => string }) => Promise<unknown>;
    return (await factory({ locateFile: (p: string) => new URL(p, baseUrl).href })) as never;
  };
}
const loadScalar = loadModule('jxl-core.scalar.js');
const loadDecSimd = loadModule('jxl-core.dec.simd.js');

afterAll(() => setJxlModuleFactoryForTesting(null));

function makePixels(width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  let state = 0x12345678 >>> 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      state = (state * 1664525 + 1013904223) >>> 0;
      const n = (state >>> 24) & 0xff;
      out[i] = (x * 2 + n) & 0xff;
      out[i + 1] = (y * 3 + (n >> 1)) & 0xff;
      out[i + 2] = ((x ^ y) + (n >> 2)) & 0xff;
      out[i + 3] = 0xff;
    }
  }
  return out;
}

async function collect(chunks: AsyncIterable<Uint8Array | ArrayBuffer>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const c of chunks) {
    const u = c instanceof Uint8Array ? c : new Uint8Array(c);
    parts.push(u);
    total += u.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.byteLength; }
  return out;
}

async function decodeFinal(
  encoded: Uint8Array,
  opts: { region: Region | null; downsample: 1 | 2 | 4 | 8 },
): Promise<{ pixels: Uint8Array; width: number; height: number; region?: Region }> {
  const decoder = createDecoder({
    format: 'rgba8',
    region: opts.region,
    downsample: opts.downsample,
    progressionTarget: 'final',
    emitEveryPass: false,
    preserveIcc: false,
    preserveMetadata: false,
  });
  let result: { pixels: Uint8Array; width: number; height: number; region?: Region } | null = null;
  const task = (async () => {
    for await (const ev of decoder.events()) {
      if (ev.type === 'error') throw new Error(ev.message);
      if (ev.type === 'final') {
        const data = ev.pixels instanceof Uint8Array ? ev.pixels : new Uint8Array(ev.pixels);
        result = { pixels: new Uint8Array(data), width: ev.info.width, height: ev.info.height, ...(ev.region ? { region: ev.region } : {}) };
      }
    }
  })();
  // Feed in chunks to exercise the progressive path.
  for (let off = 0; off < encoded.byteLength; off += 4096) {
    decoder.push(encoded.subarray(off, Math.min(encoded.byteLength, off + 4096)));
    await new Promise((r) => setTimeout(r, 0));
  }
  decoder.close();
  await task;
  await decoder.dispose();
  if (result === null) throw new Error('no final event');
  return result;
}

test('progressive ROI/downsample decode is byte-exact with the JS reference', async () => {
  const width = 96;
  const height = 64;
  const pixels = makePixels(width, height);

  // 1. Encode once with the scalar (encoder-capable) module.
  setJxlModuleFactoryForTesting(loadScalar);
  const enc = createEncoder({
    format: 'rgba8', width, height, hasAlpha: true,
    iccProfile: null, exif: null, xmp: null,
    distance: 1.0, quality: null, effort: 3,
    progressive: true, progressiveFlavor: 'ac', previewFirst: false, chunked: false,
  });
  enc.pushPixels(pixels);
  enc.finish();
  const encoded = await collect(enc.chunks());
  await enc.dispose();
  expect(encoded.byteLength).toBeGreaterThan(0);

  // 2. Decode with the split dec module (the rebuilt-with-ROI one the viewer uses).
  setJxlModuleFactoryForTesting(loadDecSimd);

  // Probe whether the rebuilt symbol is present so the run states which path it proved.
  const probe = await loadDecSimd();
  const cppRoiAvailable = typeof (probe as any)._jxl_wasm_dec_set_region === 'function';
  console.log(`[progressive-roi] cppRoiAvailable=${cppRoiAvailable}`);

  // 3. Reference full frame (no crop, no downsample).
  const full = await decodeFinal(encoded, { region: null, downsample: 1 });
  expect(full.width).toBe(width);
  expect(full.height).toBe(height);

  const cases: Array<{ region: Region | null; ds: 1 | 2 | 4 | 8 }> = [
    { region: { x: 10, y: 8, w: 50, h: 40 }, ds: 1 },
    { region: { x: 10, y: 8, w: 50, h: 40 }, ds: 2 },
    { region: { x: 33, y: 20, w: 40, h: 30 }, ds: 4 },
    { region: { x: width - 5, y: height - 5, w: 100, h: 100 }, ds: 2 }, // clamps
    { region: null, ds: 2 }, // downsample-only
  ];

  for (const c of cases) {
    const ref = applyRegionAndDownsample(full.pixels, width, height, c.region, c.ds, 1);
    const got = await decodeFinal(encoded, { region: c.region, downsample: c.ds });
    const ctx = `region=${JSON.stringify(c.region)} ds=${c.ds}`;
    expect(got.width, `${ctx}: width`).toBe(ref.width);
    expect(got.height, `${ctx}: height`).toBe(ref.height);
    expect(got.pixels.byteLength, `${ctx}: byteLength`).toBe(ref.data.byteLength);
    let diff = -1;
    for (let i = 0; i < ref.data.byteLength; i++) {
      if (got.pixels[i] !== ref.data[i]) { diff = i; break; }
    }
    expect(diff, `${ctx}: first byte mismatch at ${diff}`).toBe(-1);
    // region field parity: present iff an explicit region was requested.
    if (c.region != null) {
      expect(got.region, `${ctx}: region field`).toEqual({ x: 0, y: 0, w: ref.width, h: ref.height });
    } else {
      expect(got.region, `${ctx}: region field absent`).toBeUndefined();
    }
  }
}, 60000);
