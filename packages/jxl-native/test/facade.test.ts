import { describe, expect, test } from "bun:test";
import { CapabilityMissing, createDecoder, createEncoder, createNativeCodecFacade } from "../src/index";

const decodeOptions = {
  format: "rgba8" as const,
  region: null,
  downsample: 1 as const,
  progressionTarget: "final" as const,
  emitEveryPass: false,
  preserveIcc: true,
  preserveMetadata: true,
};

const encodeOptions = {
  format: "rgba8" as const,
  width: 1,
  height: 1,
  hasAlpha: true,
  iccProfile: null,
  exif: null,
  xmp: null,
  distance: null,
  quality: null,
  effort: 7 as const,
  progressive: false,
  previewFirst: false,
  chunked: false,
};

describe("@casabio/jxl-native facade", () => {
  test("delegates createDecoder and createEncoder to a loaded native binding", () => {
    const decoder = { push() {}, close() {}, async *events() {}, cancel() {}, dispose() {} };
    const encoder = { pushPixels() {}, finish() {}, async *chunks() {}, cancel() {}, dispose() {} };
    const facade = createNativeCodecFacade({
      version: () => "test",
      probe: () => ({ loaded: true, path: "memory" }),
      createDecoder: () => decoder,
      createEncoder: () => encoder,
    });

    expect(facade.createDecoder(decodeOptions)).toBe(decoder);
    expect(facade.createEncoder(encodeOptions)).toBe(encoder);
  });

  test("rejects a native addon that reports loaded false", () => {
    expect(() =>
      createNativeCodecFacade({
        version: () => "test",
        probe: () => ({ loaded: false, path: "stub" }),
        createDecoder: () => ({}) as never,
        createEncoder: () => ({}) as never,
      }),
    ).toThrow(CapabilityMissing);
  });

  test("top-level decoder and encoder throw CapabilityMissing when addon is unavailable", () => {
    expect(() => createDecoder(decodeOptions)).toThrow(CapabilityMissing);
    expect(() => createEncoder(encodeOptions)).toThrow(CapabilityMissing);
  });
});
