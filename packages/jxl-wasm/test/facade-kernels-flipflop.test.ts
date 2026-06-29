// Flipflop byte-exactness harness for facade hot-path kernels.
//
// Each kernel under optimization is frozen here as an OLD reference implementation
// (copied verbatim from facade.ts before the perf pass). The test asserts the
// EXPORTED (NEW) kernel produces byte-identical output across a randomized sweep of
// shapes, strides, regions and scale factors. A byte-exact refactor keeps every
// assertion green; any divergence the refactor introduces turns it red.
//
// Determinism: a seeded mulberry32 PRNG drives all random data, so failures are
// reproducible.

import { describe, expect, test } from "bun:test";
import {
  applyRegionAndDownsample,
  bilinearResize,
  buildResizeAxis,
  ButteraugliComparator,
  setJxlModuleFactoryForTesting,
} from "../src/facade";

// ----------------------------------------------------------------------------
// Seeded PRNG
// ----------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function assertBytesEqual(actual: Uint8Array, expected: Uint8Array, ctx: string): void {
  expect(actual.byteLength, `${ctx}: byteLength`).toBe(expected.byteLength);
  // Fast path: compare via DataView word scan, fall back to per-byte index on mismatch.
  let firstDiff = -1;
  for (let i = 0; i < expected.byteLength; i++) {
    if (actual[i] !== expected[i]) { firstDiff = i; break; }
  }
  if (firstDiff !== -1) {
    throw new Error(`${ctx}: byte mismatch at index ${firstDiff} (got ${actual[firstDiff]}, want ${expected[firstDiff]})`);
  }
}

type Region = { x: number; y: number; w: number; h: number };

// ----------------------------------------------------------------------------
// OLD reference impls (verbatim pre-optimization facade.ts)
// ----------------------------------------------------------------------------
function oldNormalizeRegion(region: Region | null, width: number, height: number): Region {
  if (region === null) return { x: 0, y: 0, w: width, h: height };
  const x = Math.max(0, Math.min(width - 1, Math.trunc(region.x)));
  const y = Math.max(0, Math.min(height - 1, Math.trunc(region.y)));
  const maxW = width - x;
  const maxH = height - y;
  return {
    x,
    y,
    w: Math.max(1, Math.min(maxW, Math.trunc(region.w))),
    h: Math.max(1, Math.min(maxH, Math.trunc(region.h))),
  };
}

function oldApplyRegionAndDownsample(
  data: Uint8Array,
  width: number,
  height: number,
  region: Region | null,
  downsample: 1 | 2 | 4 | 8,
  bytesPerChannel = 1,
): { data: Uint8Array; width: number; height: number; region?: Region } {
  if (downsample === 1 && region === null) return { data, width, height };

  const stride = 4 * bytesPerChannel;
  const sourceRegion = oldNormalizeRegion(region, width, height);

  if (downsample === 1 && sourceRegion.x === 0 && sourceRegion.y === 0 && sourceRegion.w === width && sourceRegion.h === height) {
    const result: { data: Uint8Array; width: number; height: number; region?: Region } = { data, width, height };
    if (region !== null) result.region = { x: 0, y: 0, w: width, h: height };
    return result;
  }

  const outWidth = Math.max(1, Math.ceil(sourceRegion.w / downsample));
  const outHeight = Math.max(1, Math.ceil(sourceRegion.h / downsample));
  const out = new Uint8Array(outWidth * outHeight * stride);

  if (downsample === 1) {
    for (let y = 0; y < outHeight; y++) {
      const srcStart = ((sourceRegion.y + y) * width + sourceRegion.x) * stride;
      out.set(data.subarray(srcStart, srcStart + outWidth * stride), y * outWidth * stride);
    }
  } else if (stride === 4) {
    for (let y = 0; y < outHeight; y++) {
      const srcRowBase = (sourceRegion.y + Math.min(sourceRegion.h - 1, y * downsample)) * width * 4;
      const dstRowBase = y * outWidth * 4;
      for (let x = 0; x < outWidth; x++) {
        const src = srcRowBase + (sourceRegion.x + Math.min(sourceRegion.w - 1, x * downsample)) * 4;
        const dst = dstRowBase + x * 4;
        out[dst] = data[src]!;
        out[dst + 1] = data[src + 1]!;
        out[dst + 2] = data[src + 2]!;
        out[dst + 3] = data[src + 3]!;
      }
    }
  } else {
    for (let y = 0; y < outHeight; y++) {
      const srcRowBase = (sourceRegion.y + Math.min(sourceRegion.h - 1, y * downsample)) * width * stride;
      const dstRowBase = y * outWidth * stride;
      for (let x = 0; x < outWidth; x++) {
        const src = srcRowBase + (sourceRegion.x + Math.min(sourceRegion.w - 1, x * downsample)) * stride;
        const dst = dstRowBase + x * stride;
        out.set(data.subarray(src, src + stride), dst);
      }
    }
  }

  const result: { data: Uint8Array; width: number; height: number; region?: Region } = {
    data: out,
    width: outWidth,
    height: outHeight,
  };
  if (region !== null) {
    result.region = { x: 0, y: 0, w: outWidth, h: outHeight };
  }
  return result;
}

function oldBuildResizeAxis(srcSize: number, dstSize: number, srcStart = 0, srcSpan = srcSize): { i0: Int32Array; i1: Int32Array; t: Float32Array } {
  const i0 = new Int32Array(dstSize);
  const i1 = new Int32Array(dstSize);
  const t = new Float32Array(dstSize);
  const scale = srcSpan / dstSize;
  for (let d = 0; d < dstSize; d++) {
    const f = srcStart + (d + 0.5) * scale - 0.5;
    const base = Math.max(0, Math.floor(f));
    i0[d] = base;
    i1[d] = Math.min(srcSize - 1, base + 1);
    t[d] = f - base;
  }
  return { i0, i1, t };
}

function oldBilinearResize(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  stride: number,
  xAxisIn?: { i0: Int32Array; i1: Int32Array; t: Float32Array },
  yAxisIn?: { i0: Int32Array; i1: Int32Array; t: Float32Array },
): Uint8Array {
  if (srcW === dstW && srcH === dstH) return src;
  const dst = new Uint8Array(dstW * dstH * stride);
  const xAxis = xAxisIn ?? oldBuildResizeAxis(srcW, dstW);
  const yAxis = yAxisIn ?? oldBuildResizeAxis(srcH, dstH);
  if (stride === 4) {
    const xtIs = new Int32Array(dstW);
    for (let dx = 0; dx < dstW; dx++) xtIs[dx] = (xAxis.t[dx]! * 256) | 0;
    for (let dy = 0; dy < dstH; dy++) {
      const y0 = yAxis.i0[dy]!;
      const y1 = yAxis.i1[dy]!;
      const ytI = (yAxis.t[dy]! * 256) | 0;
      const row00 = y0 * srcW * 4;
      const row10 = y1 * srcW * 4;
      for (let dx = 0; dx < dstW; dx++) {
        const x0 = xAxis.i0[dx]!;
        const x1 = xAxis.i1[dx]!;
        const xtI = xtIs[dx]!;
        const w11 = (xtI * ytI) >> 8;
        const w10 = ytI - w11;
        const w01 = xtI - w11;
        const w00 = 256 - xtI - ytI + w11;
        const topLeft = row00 + x0 * 4;
        const topRight = row00 + x1 * 4;
        const bottomLeft = row10 + x0 * 4;
        const bottomRight = row10 + x1 * 4;
        const dstOff = (dy * dstW + dx) * 4;
        for (let c = 0; c < 4; c++) {
          dst[dstOff + c] = (src[topLeft + c]! * w00 + src[topRight + c]! * w01 + src[bottomLeft + c]! * w10 + src[bottomRight + c]! * w11 + 128) >> 8;
        }
      }
    }
  } else if (stride === 8) {
    const srcView = new Uint16Array(src.buffer, src.byteOffset, src.byteLength >> 1);
    const dstView = new Uint16Array(dst.buffer);
    for (let dy = 0; dy < dstH; dy++) {
      const y0 = yAxis.i0[dy]!;
      const y1 = yAxis.i1[dy]!;
      const yt = yAxis.t[dy]!;
      const row00 = y0 * srcW * 4;
      const row10 = y1 * srcW * 4;
      for (let dx = 0; dx < dstW; dx++) {
        const x0 = xAxis.i0[dx]!;
        const x1 = xAxis.i1[dx]!;
        const xt = xAxis.t[dx]!;
        const w00 = (1 - xt) * (1 - yt);
        const w01 = xt * (1 - yt);
        const w10 = (1 - xt) * yt;
        const w11 = xt * yt;
        const topLeft = row00 + x0 * 4;
        const topRight = row00 + x1 * 4;
        const bottomLeft = row10 + x0 * 4;
        const bottomRight = row10 + x1 * 4;
        const dstOff = (dy * dstW + dx) * 4;
        for (let c = 0; c < 4; c++) {
          const tl = srcView[topLeft + c]!;
          const tr = srcView[topRight + c]!;
          const bl = srcView[bottomLeft + c]!;
          const br = srcView[bottomRight + c]!;
          dstView[dstOff + c] = Math.max(0, Math.min(65535, Math.round(tl * w00 + tr * w01 + bl * w10 + br * w11)));
        }
      }
    }
  } else {
    const srcView = new Float32Array(src.buffer, src.byteOffset, src.byteLength >> 2);
    const dstView = new Float32Array(dst.buffer);
    for (let dy = 0; dy < dstH; dy++) {
      const y0 = yAxis.i0[dy]!;
      const y1 = yAxis.i1[dy]!;
      const yt = yAxis.t[dy]!;
      const row00 = y0 * srcW * 4;
      const row10 = y1 * srcW * 4;
      for (let dx = 0; dx < dstW; dx++) {
        const x0 = xAxis.i0[dx]!;
        const x1 = xAxis.i1[dx]!;
        const xt = xAxis.t[dx]!;
        const w00 = (1 - xt) * (1 - yt);
        const w01 = xt * (1 - yt);
        const w10 = (1 - xt) * yt;
        const w11 = xt * yt;
        const topLeft = row00 + x0 * 4;
        const topRight = row00 + x1 * 4;
        const bottomLeft = row10 + x0 * 4;
        const bottomRight = row10 + x1 * 4;
        const dstOff = (dy * dstW + dx) * 4;
        for (let c = 0; c < 4; c++) {
          const tl = srcView[topLeft + c]!;
          const tr = srcView[topRight + c]!;
          const bl = srcView[bottomLeft + c]!;
          const br = srcView[bottomRight + c]!;
          dstView[dstOff + c] = tl * w00 + tr * w01 + bl * w10 + br * w11;
        }
      }
    }
  }
  return dst;
}

// ----------------------------------------------------------------------------
// Data generation
// ----------------------------------------------------------------------------
function randomPixels(rng: () => number, count: number, stride: number): Uint8Array {
  const buf = new Uint8Array(count * stride);
  if (stride === 16) {
    // finite float32 channel values (avoid NaN/Inf so byte comparison is meaningful)
    const f = new Float32Array(buf.buffer);
    for (let i = 0; i < f.length; i++) f[i] = (rng() * 2 - 1) * 1000;
  } else {
    for (let i = 0; i < buf.byteLength; i++) buf[i] = (rng() * 256) | 0;
  }
  return buf;
}

// Return `src` re-based at an unaligned (non-4-byte) byteOffset to exercise the
// fallback path in the optimized kernel. Only valid for stride 4 (byte data).
function unaligned(src: Uint8Array, off: number): Uint8Array {
  const wrapper = new Uint8Array(src.byteLength + off);
  wrapper.set(src, off);
  return wrapper.subarray(off);
}

// ----------------------------------------------------------------------------
// applyRegionAndDownsample flipflop
// ----------------------------------------------------------------------------
describe("applyRegionAndDownsample byte-exact flipflop", () => {
  const rng = mulberry32(0xc0ffee);
  const factors: Array<1 | 2 | 4 | 8> = [1, 2, 4, 8];
  const bpcs: Array<1 | 2 | 4> = [1, 2, 4];

  test("matches reference across shapes/regions/factors/strides (aligned)", () => {
    let cases = 0;
    for (const bpc of bpcs) {
      const stride = 4 * bpc;
      for (let iter = 0; iter < 60; iter++) {
        const width = 1 + ((rng() * 64) | 0);
        const height = 1 + ((rng() * 64) | 0);
        const data = randomPixels(rng, width * height, stride);
        // region variants: null, full, random sub-rects (incl out-of-bounds to test clamping)
        const regions: Array<Region | null> = [
          null,
          { x: 0, y: 0, w: width, h: height },
          {
            x: (rng() * width) | 0,
            y: (rng() * height) | 0,
            w: 1 + ((rng() * width) | 0),
            h: 1 + ((rng() * height) | 0),
          },
          { x: width - 1, y: height - 1, w: width * 2, h: height * 2 }, // clamps
        ];
        for (const region of regions) {
          for (const ds of factors) {
            const want = oldApplyRegionAndDownsample(data, width, height, region, ds, bpc);
            const got = applyRegionAndDownsample(data, width, height, region, ds, bpc);
            const ctx = `bpc=${bpc} ${width}x${height} region=${JSON.stringify(region)} ds=${ds}`;
            expect(got.width, `${ctx}: width`).toBe(want.width);
            expect(got.height, `${ctx}: height`).toBe(want.height);
            expect(got.region, `${ctx}: region`).toEqual(want.region);
            assertBytesEqual(got.data, want.data, ctx);
            cases++;
          }
        }
      }
    }
    expect(cases).toBeGreaterThan(500);
  });

  test("matches reference on unaligned source buffers (fallback path)", () => {
    const rng2 = mulberry32(0x1234);
    let cases = 0;
    for (const bpc of bpcs) {
      const stride = 4 * bpc;
      for (let iter = 0; iter < 30; iter++) {
        const width = 1 + ((rng2() * 40) | 0);
        const height = 1 + ((rng2() * 40) | 0);
        const base = randomPixels(rng2, width * height, stride);
        for (const off of [1, 2, 3]) {
          const data = unaligned(base, off);
          expect(data.byteOffset & 3).not.toBe(0);
          const region: Region = { x: 0, y: 0, w: width, h: height };
          for (const ds of factors) {
            const want = oldApplyRegionAndDownsample(data, width, height, region, ds, bpc);
            const got = applyRegionAndDownsample(data, width, height, region, ds, bpc);
            const ctx = `unaligned off=${off} bpc=${bpc} ${width}x${height} ds=${ds}`;
            assertBytesEqual(got.data, want.data, ctx);
            cases++;
          }
        }
      }
    }
    expect(cases).toBeGreaterThan(200);
  });
});

// ----------------------------------------------------------------------------
// buildResizeAxis flipflop
// ----------------------------------------------------------------------------
describe("buildResizeAxis byte-exact flipflop", () => {
  test("i0/i1/t identical to reference across sizes and spans", () => {
    const rng = mulberry32(0xaa55);
    for (let iter = 0; iter < 200; iter++) {
      const srcSize = 1 + ((rng() * 200) | 0);
      const dstSize = 1 + ((rng() * 200) | 0);
      const srcStart = rng() < 0.5 ? 0 : rng() * srcSize;
      const srcSpan = rng() < 0.5 ? srcSize : Math.max(1, rng() * srcSize);
      const want = oldBuildResizeAxis(srcSize, dstSize, srcStart, srcSpan);
      const got = buildResizeAxis(srcSize, dstSize, srcStart, srcSpan);
      expect(Array.from(got.i0)).toEqual(Array.from(want.i0));
      expect(Array.from(got.i1)).toEqual(Array.from(want.i1));
      expect(Array.from(got.t)).toEqual(Array.from(want.t));
    }
  });
});

// ----------------------------------------------------------------------------
// bilinearResize flipflop
// ----------------------------------------------------------------------------
describe("bilinearResize byte-exact flipflop", () => {
  const strides = [4, 8, 16];

  test("matches reference for up/down scaling, all strides, auto + provided axes", () => {
    const rng = mulberry32(0xbeef);
    let cases = 0;
    for (const stride of strides) {
      for (let iter = 0; iter < 50; iter++) {
        const srcW = 1 + ((rng() * 48) | 0);
        const srcH = 1 + ((rng() * 48) | 0);
        const dstW = 1 + ((rng() * 48) | 0);
        const dstH = 1 + ((rng() * 48) | 0);
        const src = randomPixels(rng, srcW * srcH, stride);
        // auto axes
        {
          const want = oldBilinearResize(src.slice(), srcW, srcH, dstW, dstH, stride);
          const got = bilinearResize(src.slice(), srcW, srcH, dstW, dstH, stride);
          assertBytesEqual(got, want, `auto stride=${stride} ${srcW}x${srcH}->${dstW}x${dstH}`);
          cases++;
        }
        // provided axes (built fresh per impl so cache state cannot leak between them)
        {
          const wantX = oldBuildResizeAxis(srcW, dstW);
          const wantY = oldBuildResizeAxis(srcH, dstH);
          const gotX = buildResizeAxis(srcW, dstW);
          const gotY = buildResizeAxis(srcH, dstH);
          const want = oldBilinearResize(src.slice(), srcW, srcH, dstW, dstH, stride, wantX, wantY);
          const got = bilinearResize(src.slice(), srcW, srcH, dstW, dstH, stride, gotX, gotY);
          assertBytesEqual(got, want, `provided stride=${stride} ${srcW}x${srcH}->${dstW}x${dstH}`);
          cases++;
        }
      }
    }
    expect(cases).toBeGreaterThan(200);
  });

  test("reused axis (multi-paint) stays byte-exact on second call", () => {
    const rng = mulberry32(0x77);
    for (const stride of [4, 8, 16]) {
      const srcW = 33, srcH = 21, dstW = 12, dstH = 9;
      const src = randomPixels(rng, srcW * srcH, stride);
      const x = buildResizeAxis(srcW, dstW);
      const y = buildResizeAxis(srcH, dstH);
      const want = oldBilinearResize(src.slice(), srcW, srcH, dstW, dstH, stride);
      const first = bilinearResize(src.slice(), srcW, srcH, dstW, dstH, stride, x, y);
      const second = bilinearResize(src.slice(), srcW, srcH, dstW, dstH, stride, x, y);
      assertBytesEqual(first, want, `reuse-first stride=${stride}`);
      assertBytesEqual(second, want, `reuse-second stride=${stride}`);
    }
  });
});

// ----------------------------------------------------------------------------
// ButteraugliComparator candidate-scratch reuse (behavioral)
// ----------------------------------------------------------------------------
function f32Bits(value: number): number {
  const f = new Float32Array(1);
  const i = new Int32Array(f.buffer);
  f[0] = value;
  return i[0]!;
}

function makeFakeButteraugliModule() {
  const memory = new ArrayBuffer(1 << 20);
  const HEAPU8 = new Uint8Array(memory);
  const HEAP32 = new Int32Array(memory);
  const HEAPU32 = new Uint32Array(memory);
  let nextPtr = 64;
  const live = new Set<number>();
  let mallocCount = 0;
  let freeCount = 0;
  return {
    HEAPU8,
    HEAP32,
    HEAPU32,
    get mallocCount() { return mallocCount; },
    get freeCount() { return freeCount; },
    get liveCount() { return live.size; },
    _malloc(size: number) {
      mallocCount++;
      const ptr = nextPtr;
      nextPtr += size + 16;
      live.add(ptr);
      return ptr;
    },
    _free(ptr: number) {
      if (ptr !== 0 && live.has(ptr)) { live.delete(ptr); freeCount++; }
    },
    // Legacy compare path: distance derived from candidate's first byte so the test
    // proves the (reused) scratch buffer receives fresh candidate bytes each call.
    _jxl_wasm_butteraugli_compare(_refPtr: number, candPtr: number, _w: number, _h: number) {
      return f32Bits(HEAPU8[candPtr]! / 100);
    },
  } as any;
}

describe("ButteraugliComparator candidate scratch reuse", () => {
  test("reuses one candidate allocation across N compares, with correct distances", async () => {
    const fake = makeFakeButteraugliModule();
    setJxlModuleFactoryForTesting(async () => fake);
    try {
      const w = 4, h = 4;
      const pixelSize = w * h * 4;
      const ref = new Uint8Array(pixelSize); // ref content irrelevant to fake
      const cmp = await ButteraugliComparator.create(ref, w, h);

      const mallocAfterCreate = fake.mallocCount;

      const distances: number[] = [];
      const firstBytes = [7, 42, 200, 1, 255];
      for (const b of firstBytes) {
        const cand = new Uint8Array(pixelSize);
        cand[0] = b;
        distances.push(cmp.compare(cand));
      }

      // Correctness: each compare reflects the candidate actually copied in.
      for (let i = 0; i < firstBytes.length; i++) {
        expect(distances[i]).toBeCloseTo(firstBytes[i]! / 100, 5);
      }

      // Reuse: exactly one new allocation for the candidate scratch across all compares.
      expect(fake.mallocCount - mallocAfterCreate).toBe(1);

      // Dispose frees everything it allocated (ref + candidate scratch).
      cmp.dispose();
      expect(fake.liveCount).toBe(0);
    } finally {
      setJxlModuleFactoryForTesting(null);
    }
  });
});
