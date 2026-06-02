import { describe, expect, test } from "bun:test";
import { createDecoder, createEncoder, type DecodeEvent } from "../src/index";

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

describe("progressive encode types (predator Tauri parity) in native index.ts", () => {
  test("EncoderOptions declares progressiveDc and groupOrder for multi-layer progressive", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(source).toContain("progressiveDc?: 0 | 1 | 2");
    expect(source).toContain("groupOrder?: 0 | 1");
    // wiring via convert to adv ids (19=PROGRESSIVE_DC, 13=GROUP_ORDER) so no cc change needed
    expect(source).toContain("id: 19");
    expect(source).toContain("id: 13");
    expect(source).toContain("Top-level progressiveDc");
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
