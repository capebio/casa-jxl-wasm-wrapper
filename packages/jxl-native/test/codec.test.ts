import { describe, expect, test } from "bun:test";
import {
  createDecoder,
  createEncoder,
  encodeJxtcRgba8,
  decodeJxtcRegionRgba8,
  type DecodeEvent,
} from "../src/index";

const nativeIncludeDir =
  "C:\\Foo\\raw-converter\\target\\release\\build\\jpegxl-sys-26f294f2024eaecb\\out\\include";
const nativeLibDir = "C:\\TEMP\\jxl-mt-libs";

function asUint8Array(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function concat(chunks: Array<ArrayBuffer | Uint8Array>): Uint8Array {
  const views = chunks.map(asUint8Array);
  const size = views.reduce((total, chunk) => total + chunk.byteLength, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of views) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

describe("@casabio/jxl-native real codec", () => {
  test("round-trips a 2x2 rgba8 image through libjxl", async () => {
    expect(process.env.JXL_NATIVE_INCLUDE_DIR).toBe(nativeIncludeDir);
    expect(process.env.JXL_NATIVE_LIB_DIR).toBe(nativeLibDir);

    const pixels = new Uint8Array([
      255, 0, 0, 255,
      0, 255, 0, 255,
      0, 0, 255, 255,
      255, 255, 255, 255,
    ]);

    const encoder = createEncoder({
      format: "rgba8",
      width: 2,
      height: 2,
      hasAlpha: true,
      iccProfile: null,
      exif: null,
      xmp: null,
      distance: 0,
      quality: null,
      effort: 3,
      progressive: false,
      previewFirst: false,
      chunked: false,
    });

    await encoder.pushPixels(pixels);
    await encoder.finish();
    const encoded = concat(await Array.fromAsync(encoder.chunks()));
    expect(encoded.byteLength).toBeGreaterThan(0);

    const decoder = createDecoder({
      format: "rgba8",
      region: null,
      downsample: 1,
      progressionTarget: "final",
      emitEveryPass: false,
      preserveIcc: true,
      preserveMetadata: true,
    });

    await decoder.push(encoded);
    await decoder.close();
    const events = await Array.fromAsync(decoder.events());
    const final = events.find((event): event is Extract<DecodeEvent, { type: "final" }> => event.type === "final");

    expect(final).toBeDefined();
    expect(final?.info.width).toBe(2);
    expect(final?.info.height).toBe(2);
    expect(final?.pixels.byteLength).toBe(2 * 2 * 4);
    const decoded = asUint8Array(final!.pixels);
    for (let i = 0; i < pixels.byteLength; i += 1) {
      expect(Math.abs(decoded[i]! - pixels[i]!)).toBeLessThanOrEqual(2);
    }
  });

  test("encodes with brotliEffort:5 and round-trips correctly", async () => {
    expect(process.env.JXL_NATIVE_INCLUDE_DIR).toBe(nativeIncludeDir);
    expect(process.env.JXL_NATIVE_LIB_DIR).toBe(nativeLibDir);

    const pixels = new Uint8Array([128, 64, 32, 255, 0, 128, 255, 255]);

    const encoder = createEncoder({
      format: "rgba8",
      width: 2,
      height: 1,
      hasAlpha: true,
      iccProfile: null,
      exif: null,
      xmp: null,
      distance: 0,
      quality: null,
      effort: 3,
      progressive: false,
      previewFirst: false,
      chunked: false,
      brotliEffort: 5,
    });

    await encoder.pushPixels(pixels);
    await encoder.finish();
    const encoded = concat(await Array.fromAsync(encoder.chunks()));
    expect(encoded.byteLength).toBeGreaterThan(0);

    const decoder = createDecoder({
      format: "rgba8",
      region: null,
      downsample: 1,
      progressionTarget: "final",
      emitEveryPass: false,
      preserveIcc: true,
      preserveMetadata: true,
    });

    await decoder.push(encoded);
    await decoder.close();
    const events = await Array.fromAsync(decoder.events());
    const final = events.find((event): event is Extract<DecodeEvent, { type: "final" }> => event.type === "final");

    expect(final).toBeDefined();
    expect(final?.info.width).toBe(2);
    expect(final?.info.height).toBe(1);
    expect(final?.pixels.byteLength).toBe(2 * 1 * 4);
  });
});

describe("extra channel types in native index.ts", () => {
  test("ExtraChannel interface is defined in index.ts", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(source).toContain("export interface ExtraChannel");
    expect(source).toContain("bitsPerSample: number");
    expect(source).toContain("distance?: number");
  });

  test("EncoderOptions has alphaDistance, extraChannels, extraChannelPlanes fields", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(source).toContain("alphaDistance?: number");
    expect(source).toContain("extraChannels?: readonly ExtraChannel[]");
    expect(source).toContain("extraChannelPlanes?: readonly (ArrayBuffer | Uint8Array)[]");
  });
});

describe("animation types in native index.ts", () => {
  test("NativeEncoderOptions has animation and frames fields", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(source).toContain("AnimationFrame");
    expect(source).toContain("AnimationOptions");
    expect(source).toContain("animation?: AnimationOptions");
    expect(source).toContain("frames?: readonly AnimationFrame[]");
  });

  test("native DecodeEvent has frameIndex/frameDuration/frameName fields", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(source).toContain("frameIndex?: number");
    expect(source).toContain("frameDuration?: number");
    expect(source).toContain("frameName?: string");
  });
});

describe("@casabio/jxl-native extra channel roundtrips", () => {
  test("encodes with alphaDistance:0 (lossless alpha) and round-trips correctly", async () => {
    expect(process.env.JXL_NATIVE_INCLUDE_DIR).toBe(nativeIncludeDir);
    expect(process.env.JXL_NATIVE_LIB_DIR).toBe(nativeLibDir);

    // 2×2 RGBA8: pixels with semi-transparent alpha
    const pixels = new Uint8Array([
      255, 0, 0, 128,
      0, 255, 0, 64,
      0, 0, 255, 192,
      255, 255, 0, 255,
    ]);

    const encoder = createEncoder({
      format: "rgba8",
      width: 2,
      height: 2,
      hasAlpha: true,
      iccProfile: null,
      exif: null,
      xmp: null,
      distance: 0,
      quality: null,
      effort: 3,
      progressive: false,
      previewFirst: false,
      chunked: false,
      alphaDistance: 0,
    });

    await encoder.pushPixels(pixels);
    await encoder.finish();
    const encoded = concat(await Array.fromAsync(encoder.chunks()));
    expect(encoded.byteLength).toBeGreaterThan(0);

    const decoder = createDecoder({
      format: "rgba8",
      region: null,
      downsample: 1,
      progressionTarget: "final",
      emitEveryPass: false,
      preserveIcc: true,
      preserveMetadata: true,
    });

    await decoder.push(encoded);
    await decoder.close();
    const events = await Array.fromAsync(decoder.events());
    const final = events.find((e): e is Extract<DecodeEvent, { type: "final" }> => e.type === "final");

    expect(final).toBeDefined();
    expect(final?.info.width).toBe(2);
    expect(final?.info.height).toBe(2);
    // lossless alpha: alpha channel bytes must match exactly
    const decoded = asUint8Array(final!.pixels);
    for (let i = 3; i < pixels.byteLength; i += 4) {
      expect(decoded[i]).toBe(pixels[i]);
    }
  });

  test("encodes with extraChannels depth plane and decodes extraPlanes", async () => {
    expect(process.env.JXL_NATIVE_INCLUDE_DIR).toBe(nativeIncludeDir);
    expect(process.env.JXL_NATIVE_LIB_DIR).toBe(nativeLibDir);

    const pixels = new Uint8Array([
      200, 100, 50, 255,
      150, 80, 30, 255,
      100, 60, 20, 255,
      50, 40, 10, 255,
    ]);
    // Single-channel 8-bit depth plane (lossless)
    const depthPlane = new Uint8Array([0, 64, 128, 255]);

    const encoder = createEncoder({
      format: "rgba8",
      width: 2,
      height: 2,
      hasAlpha: false,
      iccProfile: null,
      exif: null,
      xmp: null,
      distance: 0,
      quality: null,
      effort: 3,
      progressive: false,
      previewFirst: false,
      chunked: false,
      extraChannels: [{ type: "depth", bitsPerSample: 8, distance: 0 }],
      extraChannelPlanes: [depthPlane],
    });

    await encoder.pushPixels(pixels);
    await encoder.finish();
    const encoded = concat(await Array.fromAsync(encoder.chunks()));
    expect(encoded.byteLength).toBeGreaterThan(0);

    const decoder = createDecoder({
      format: "rgba8",
      region: null,
      downsample: 1,
      progressionTarget: "final",
      emitEveryPass: false,
      preserveIcc: true,
      preserveMetadata: true,
    });

    await decoder.push(encoded);
    await decoder.close();
    const events = await Array.fromAsync(decoder.events());
    const final = events.find((e): e is Extract<DecodeEvent, { type: "final" }> => e.type === "final");

    expect(final).toBeDefined();
    expect(final?.extraPlanes).toBeDefined();
    expect(final!.extraPlanes!.length).toBe(1);
    expect(final!.extraPlanes![0]!.byteLength).toBe(4);
    // Lossless depth channel must round-trip exactly
    const decoded = new Uint8Array(final!.extraPlanes![0]!);
    for (let i = 0; i < depthPlane.byteLength; i++) {
      expect(decoded[i]).toBe(depthPlane[i]);
    }
  });
});

describe("@casabio/jxl-native modular and advanced settings", () => {
  test("encodes with modularOptions force+predictor and produces valid JXL", async () => {
    expect(process.env.JXL_NATIVE_INCLUDE_DIR).toBe(nativeIncludeDir);
    expect(process.env.JXL_NATIVE_LIB_DIR).toBe(nativeLibDir);

    const pixels = new Uint8Array([10, 20, 30, 255, 40, 50, 60, 255]);

    const encoder = createEncoder({
      format: "rgba8",
      width: 2,
      height: 1,
      hasAlpha: true,
      iccProfile: null,
      exif: null,
      xmp: null,
      distance: 0,
      quality: null,
      effort: 3,
      progressive: false,
      previewFirst: false,
      chunked: false,
      modular: 1,
      modularOptions: { predictor: 0, groupSize: 0 },
    });

    await encoder.pushPixels(pixels);
    await encoder.finish();
    const encoded = concat(await Array.fromAsync(encoder.chunks()));
    expect(encoded.byteLength).toBeGreaterThan(0);

    // Verify it decodes back successfully
    const decoder = createDecoder({
      format: "rgba8",
      region: null,
      downsample: 1,
      progressionTarget: "final",
      emitEveryPass: false,
      preserveIcc: true,
      preserveMetadata: true,
    });
    await decoder.push(encoded);
    await decoder.close();
    const events = await Array.fromAsync(decoder.events());
    const final = events.find((e): e is Extract<DecodeEvent, { type: "final" }> => e.type === "final");
    expect(final).toBeDefined();
    expect(final?.info.width).toBe(2);
  });

  test("encodes with advancedFrameSettings (patches=8) and produces valid JXL", async () => {
    expect(process.env.JXL_NATIVE_INCLUDE_DIR).toBe(nativeIncludeDir);
    expect(process.env.JXL_NATIVE_LIB_DIR).toBe(nativeLibDir);

    const pixels = new Uint8Array([10, 20, 30, 255, 40, 50, 60, 255]);

    const encoder = createEncoder({
      format: "rgba8",
      width: 2,
      height: 1,
      hasAlpha: true,
      iccProfile: null,
      exif: null,
      xmp: null,
      distance: 0,
      quality: null,
      effort: 3,
      progressive: false,
      previewFirst: false,
      chunked: false,
      advancedFrameSettings: [{ id: 8, value: 1 }], // JXL_ENC_FRAME_SETTING_PATCHES = 8
    });

    await encoder.pushPixels(pixels);
    await encoder.finish();
    const encoded = concat(await Array.fromAsync(encoder.chunks()));
    expect(encoded.byteLength).toBeGreaterThan(0);
  });
});

describe("@casabio/jxl-native custom boxes", () => {
  test("encodes with customBoxes and produces non-empty output", async () => {
    expect(process.env.JXL_NATIVE_INCLUDE_DIR).toBe(nativeIncludeDir);
    expect(process.env.JXL_NATIVE_LIB_DIR).toBe(nativeLibDir);

    const pixels = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]);
    const customData = new Uint8Array([0xca, 0xfe, 0xba, 0xbe]);

    const encoder = createEncoder({
      format: "rgba8",
      width: 2,
      height: 1,
      hasAlpha: true,
      iccProfile: null,
      exif: null,
      xmp: null,
      distance: 0,
      quality: null,
      effort: 3,
      progressive: false,
      previewFirst: false,
      chunked: false,
      customBoxes: [{ type: "casb", data: customData, compress: false }],
    });

    await encoder.pushPixels(pixels);
    await encoder.finish();
    const encoded = concat(await Array.fromAsync(encoder.chunks()));
    // Container forced by custom box — output must be larger than a raw codestream
    expect(encoded.byteLength).toBeGreaterThan(32);
  });
});

describe("@casabio/jxl-native animation", () => {
  test("encodes 2-frame animation and decodes frame metadata", async () => {
    expect(process.env.JXL_NATIVE_INCLUDE_DIR).toBe(nativeIncludeDir);
    expect(process.env.JXL_NATIVE_LIB_DIR).toBe(nativeLibDir);

    const frame1 = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]);
    const frame2 = new Uint8Array([0, 0, 255, 255, 255, 255, 0, 255]);

    const encoder = createEncoder({
      format: "rgba8",
      width: 2,
      height: 1,
      hasAlpha: true,
      iccProfile: null,
      exif: null,
      xmp: null,
      distance: 0,
      quality: null,
      effort: 3,
      progressive: false,
      previewFirst: false,
      chunked: false,
      animation: { ticksPerSecond: 100, loopCount: 0 },
      frames: [
        { data: frame1, width: 2, height: 1, duration: 10, name: "f1" },
        { data: frame2, width: 2, height: 1, duration: 20, name: "f2" },
      ],
    });

    await encoder.finish();
    const encoded = concat(await Array.fromAsync(encoder.chunks()));
    expect(encoded.byteLength).toBeGreaterThan(0);

    const decoder = createDecoder({
      format: "rgba8",
      region: null,
      downsample: 1,
      progressionTarget: "final",
      emitEveryPass: false,
      preserveIcc: true,
      preserveMetadata: true,
    });

    await decoder.push(encoded);
    await decoder.close();
    const events = await Array.fromAsync(decoder.events());
    const header = events.find((e): e is Extract<DecodeEvent, { type: "header" }> => e.type === "header");
    expect(header?.info.hasAnimation).toBe(true);

    const final = events.find((e): e is Extract<DecodeEvent, { type: "final" }> => e.type === "final");
    expect(final).toBeDefined();
    expect(final?.animTicksPerSecond).toBe(100);
    expect(final?.frameIndex).toBeGreaterThanOrEqual(0);
  });
});

describe("progressive encode", () => {
  test("progressive:true produces valid JXL and decoder emits progress event", async () => {
    const W = 512, H = 512;
    // Use pseudo-random noise to prevent libjxl from collapsing to a trivially small
    // codestream that has no DC groups and therefore no DC progression pass.
    const pixels = new Uint8Array(W * H * 4);
    let seed = 0x12345678;
    for (let i = 0; i < pixels.length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      pixels[i] = seed & 0xff;
    }

    const encoder = createEncoder({
      format: "rgba8",
      width: W,
      height: H,
      hasAlpha: true,
      iccProfile: null,
      exif: null,
      xmp: null,
      distance: 1.0,
      quality: null,
      effort: 7,
      progressive: true,
      previewFirst: true,
      chunked: false,
    });

    await encoder.pushPixels(pixels);
    await encoder.finish();
    const encoded = concat(await Array.fromAsync(encoder.chunks()));
    expect(encoded.byteLength).toBeGreaterThan(0);

    const decoder = createDecoder({
      format: "rgba8",
      region: null,
      downsample: 1,
      progressionTarget: "pass",
      emitEveryPass: true,
      preserveIcc: false,
      preserveMetadata: false,
    });

    await decoder.push(encoded);
    await decoder.close();
    const events = await Array.fromAsync(decoder.events());
    console.log("DEBUG encoded size:", encoded.byteLength);
    console.log("DEBUG events:", events.map(e => e.type));
    const hasFinal = events.some(e => e.type === "final");
    expect(hasFinal).toBe(true);
    // With a 256×256 image and previewFirst:true, libjxl emits at least one DC progress pass.
    const hasProgress = events.some(e => e.type === "progress");
    expect(hasProgress).toBe(true);
    const finalEvent = events.find((e): e is Extract<DecodeEvent, { type: "final" }> => e.type === "final");
    expect(finalEvent?.info.width).toBe(W);
    expect(finalEvent?.info.height).toBe(H);
  });

  test("progressive:true, previewFirst:false (DC only) produces valid JXL", async () => {
    const W = 256, H = 256;
    const pixels = new Uint8Array(W * H * 4).fill(128);

    const encoder = createEncoder({
      format: "rgba8",
      width: W,
      height: H,
      hasAlpha: true,
      iccProfile: null,
      exif: null,
      xmp: null,
      distance: 1.0,
      quality: null,
      effort: 3,
      progressive: true,
      previewFirst: false,
      chunked: false,
    });

    await encoder.pushPixels(pixels);
    await encoder.finish();
    const encoded = concat(await Array.fromAsync(encoder.chunks()));
    expect(encoded.byteLength).toBeGreaterThan(0);

    const decoder = createDecoder({
      format: "rgba8",
      region: null,
      downsample: 1,
      progressionTarget: "pass",
      emitEveryPass: true,
      preserveIcc: false,
      preserveMetadata: false,
    });
    await decoder.push(encoded);
    await decoder.close();
    const events = await Array.fromAsync(decoder.events());
    console.log("DEBUG dc-only events:", events.map(e => e.type));
    const finalEvent = events.find((e): e is Extract<DecodeEvent, { type: "final" }> => e.type === "final");
    expect(finalEvent).toBeDefined();
    expect(finalEvent?.info.width).toBe(W);
    expect(finalEvent?.info.height).toBe(H);
  });
});

describe("JXTC tile container in native index.ts", () => {
  test("JxtcEncodeOptions interface is defined", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(source).toContain("export interface JxtcEncodeOptions");
    expect(source).toContain("distance?: number");
    expect(source).toContain("effort?: number");
    expect(source).toContain("hasAlpha?: boolean");
  });

  test("JxtcDecodeResult interface is defined", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(source).toContain("export interface JxtcDecodeResult");
    expect(source).toContain("pixels: ArrayBuffer");
    expect(source).toContain("width: number");
    expect(source).toContain("height: number");
  });

  test("NativeBinding has encodeJxtcRgba8 and decodeJxtcRegionRgba8", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(source).toContain("encodeJxtcRgba8?:");
    expect(source).toContain("decodeJxtcRegionRgba8?:");
  });
});

describe("@casabio/jxl-native JXTC round-trip", () => {
  test("encode + decode full image (single tile)", async () => {
    expect(process.env.JXL_NATIVE_INCLUDE_DIR).toBe(nativeIncludeDir);
    expect(process.env.JXL_NATIVE_LIB_DIR).toBe(nativeLibDir);

    // 4×4 RGBA8 gradient — fits in one tile (tileSize=16)
    const pixels = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i++) {
      pixels[i * 4 + 0] = i * 16;        // R
      pixels[i * 4 + 1] = 255 - i * 16;  // G
      pixels[i * 4 + 2] = 128;           // B
      pixels[i * 4 + 3] = 255;           // A
    }

    const container = encodeJxtcRgba8(pixels.buffer, 4, 4, 16, {
      distance: 0, effort: 1, hasAlpha: true,
    });
    expect(container.byteLength).toBeGreaterThan(32);

    // Verify JXTC magic bytes (little-endian 0x4354584A = 'JXTC')
    const header = new Uint8Array(container, 0, 4);
    expect(header[0]).toBe(0x4a); // 'J'
    expect(header[1]).toBe(0x58); // 'X'
    expect(header[2]).toBe(0x54); // 'T'
    expect(header[3]).toBe(0x43); // 'C'

    const result = decodeJxtcRegionRgba8(container, 0, 0, 4, 4);
    expect(result.width).toBe(4);
    expect(result.height).toBe(4);
    expect(result.pixels.byteLength).toBe(4 * 4 * 4);

    const decoded = new Uint8Array(result.pixels);
    for (let i = 0; i < 16; i++) {
      // distance=0 is lossless — decoded values must be exact
      expect(decoded[i * 4 + 0]).toBe(pixels[i * 4 + 0]);
      expect(decoded[i * 4 + 1]).toBe(pixels[i * 4 + 1]);
      expect(decoded[i * 4 + 2]).toBe(pixels[i * 4 + 2]);
    }
  });

  test("encode + decode multi-tile image with ROI per quadrant", async () => {
    expect(process.env.JXL_NATIVE_INCLUDE_DIR).toBe(nativeIncludeDir);
    expect(process.env.JXL_NATIVE_LIB_DIR).toBe(nativeLibDir);

    // 8×8 RGBA8 quadrant image: TL=red, TR=green, BL=blue, BR=white
    const pixels = new Uint8Array(8 * 8 * 4);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const i = (y * 8 + x) * 4;
        const right  = x >= 4;
        const bottom = y >= 4;
        pixels[i + 0] = (!right && !bottom) ? 255 : (right && !bottom) ? 0   : (right && bottom) ? 255 : 0;
        pixels[i + 1] = (!right && !bottom) ? 0   : (right && !bottom) ? 255 : (right && bottom) ? 255 : 0;
        pixels[i + 2] = (!right && !bottom) ? 0   : (right && !bottom) ? 0   : (right && bottom) ? 255 : 255;
        pixels[i + 3] = 255;
      }
    }

    // Encode with tileSize=4 → 2×2 = 4 tiles
    const container = encodeJxtcRgba8(pixels.buffer, 8, 8, 4, {
      distance: 0, effort: 1, hasAlpha: false,
    });

    // Verify header fields via DataView
    const dv = new DataView(container);
    expect(dv.getUint32(0, true)).toBe(0x4354584a); // magic
    expect(dv.getUint32(4, true)).toBe(1);           // version
    expect(dv.getUint32(8, true)).toBe(8);           // image_w
    expect(dv.getUint32(12, true)).toBe(8);          // image_h
    expect(dv.getUint32(16, true)).toBe(4);          // tile_size
    expect(dv.getUint32(20, true)).toBe(2);          // tiles_x
    expect(dv.getUint32(24, true)).toBe(2);          // tiles_y
    expect(dv.getUint32(28, true)).toBe(0);          // flags: bit0=has_alpha=false

    // Top-left tile (0,0,4,4) → should be predominantly red
    const tl = decodeJxtcRegionRgba8(container, 0, 0, 4, 4);
    expect(tl.width).toBe(4);
    expect(tl.height).toBe(4);
    const tlPx = new Uint8Array(tl.pixels);
    const tlCenter = (1 * 4 + 1) * 4; // pixel (1,1) in the tile
    expect(tlPx[tlCenter + 0]).toBeGreaterThan(200); // R high
    expect(tlPx[tlCenter + 1]).toBeLessThan(50);     // G low
    expect(tlPx[tlCenter + 2]).toBeLessThan(50);     // B low

    // Bottom-right tile (4,4,4,4) → should be predominantly white
    const br = decodeJxtcRegionRgba8(container, 4, 4, 4, 4);
    expect(br.width).toBe(4);
    expect(br.height).toBe(4);
    const brPx = new Uint8Array(br.pixels);
    const brCenter = (1 * 4 + 1) * 4;
    expect(brPx[brCenter + 0]).toBeGreaterThan(200); // R high
    expect(brPx[brCenter + 1]).toBeGreaterThan(200); // G high
    expect(brPx[brCenter + 2]).toBeGreaterThan(200); // B high
  });

  test("encode + decode cross-tile ROI strip spanning tile boundary", async () => {
    expect(process.env.JXL_NATIVE_INCLUDE_DIR).toBe(nativeIncludeDir);
    expect(process.env.JXL_NATIVE_LIB_DIR).toBe(nativeLibDir);

    // 8×4 RGBA8: left half (x<4) red, right half (x≥4) green
    const pixels = new Uint8Array(8 * 4 * 4);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 8; x++) {
        const i = (y * 8 + x) * 4;
        pixels[i + 0] = x < 4 ? 255 : 0;
        pixels[i + 1] = x < 4 ? 0 : 255;
        pixels[i + 2] = 0;
        pixels[i + 3] = 255;
      }
    }

    const container = encodeJxtcRgba8(pixels.buffer, 8, 4, 4, {
      distance: 0, effort: 1, hasAlpha: false,
    });

    // Cross-tile strip: x=3..4, y=0..3 (spans the left→right tile boundary)
    const strip = decodeJxtcRegionRgba8(container, 3, 0, 2, 4);
    expect(strip.width).toBe(2);
    expect(strip.height).toBe(4);
    const stripPx = new Uint8Array(strip.pixels);

    for (let row = 0; row < 4; row++) {
      const leftIdx  = (row * 2 + 0) * 4; // x=3 in output → red
      const rightIdx = (row * 2 + 1) * 4; // x=4 in output → green
      expect(stripPx[leftIdx  + 0]).toBeGreaterThan(200); // R at x=3
      expect(stripPx[leftIdx  + 1]).toBeLessThan(50);     // G at x=3
      expect(stripPx[rightIdx + 0]).toBeLessThan(50);     // R at x=4
      expect(stripPx[rightIdx + 1]).toBeGreaterThan(200); // G at x=4
    }
  });
});
