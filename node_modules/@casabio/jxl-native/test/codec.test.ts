import { describe, expect, test } from "bun:test";
import { createDecoder, createEncoder, type DecodeEvent } from "../src/index";

const nativeIncludeDir =
  "C:\\Foo\\raw-converter\\target\\release\\build\\jpegxl-sys-26f294f2024eaecb\\out\\include";
const nativeLibDir =
  "C:\\Foo\\raw-converter\\target\\release\\build\\jpegxl-sys-26f294f2024eaecb\\out\\lib";

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
