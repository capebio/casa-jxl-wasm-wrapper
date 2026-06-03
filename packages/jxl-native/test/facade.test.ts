import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CapabilityMissing, createNativeCodecFacade, loadNativeBinding } from "../src/index";

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

    const wrappedDecoder = facade.createDecoder(decodeOptions);
    expect(wrappedDecoder.push).toBe(decoder.push);
    expect(typeof wrappedDecoder.seekToFrame).toBe("function");
    expect(typeof wrappedDecoder.seekToTime).toBe("function");
    expect(facade.createEncoder(encodeOptions)).toBe(encoder);
  });

  test("forwards codestreamLevel to the native binding", () => {
    const encoder = { pushPixels() {}, finish() {}, async *chunks() {}, cancel() {}, dispose() {} };
    let received: unknown;
    const facade = createNativeCodecFacade({
      version: () => "test",
      probe: () => ({ loaded: true, path: "memory" }),
      createDecoder: () => ({ push() {}, close() {}, async *events() {}, cancel() {}, dispose() {} }),
      createEncoder: (options) => {
        received = options;
        return encoder;
      },
    });

    facade.createEncoder({ ...encodeOptions, codestreamLevel: 10 } as typeof encodeOptions & { codestreamLevel: 10 });

    expect((received as { codestreamLevel?: number }).codestreamLevel).toBe(10);
  });

  test("lowers streamingInput buffering controls to native frame setting ID 34", () => {
    const encoder = { pushPixels() {}, finish() {}, async *chunks() {}, cancel() {}, dispose() {} };
    let received: unknown;
    const facade = createNativeCodecFacade({
      version: () => "test",
      probe: () => ({ loaded: true, path: "memory" }),
      createDecoder: () => ({ push() {}, close() {}, async *events() {}, cancel() {}, dispose() {} }),
      createEncoder: (options) => {
        received = options;
        return encoder;
      },
    });

    facade.createEncoder({
      ...encodeOptions,
      advancedControls: { buffering: { streamingInput: true } },
    });

    expect((received as { advancedFrameSettings?: readonly { id: number; value: number }[] }).advancedFrameSettings)
      .toContainEqual({ id: 34, value: 3 });
  });

  test("lowers ecResampling to native frame setting ID 3", () => {
    const encoder = { pushPixels() {}, finish() {}, async *chunks() {}, cancel() {}, dispose() {} };
    let received: unknown;
    const facade = createNativeCodecFacade({
      version: () => "test",
      probe: () => ({ loaded: true, path: "memory" }),
      createDecoder: () => ({ push() {}, close() {}, async *events() {}, cancel() {}, dispose() {} }),
      createEncoder: (options) => {
        received = options;
        return encoder;
      },
    });

    facade.createEncoder({ ...encodeOptions, ecResampling: 4 });

    expect((received as { advancedFrameSettings?: readonly { id: number; value: number }[] }).advancedFrameSettings)
      .toContainEqual({ id: 3, value: 4 });
  });

  test("native addon parses and applies codestreamLevel", () => {
    const source = readFileSync(new URL("../src/native.cc", import.meta.url), "utf8");

    expect(source).toContain("\"codestreamLevel\"");
    expect(source).toContain("JxlEncoderSetCodestreamLevel");
  });

  test("native addon parses and applies premultiply alpha signaling", () => {
    const source = readFileSync(new URL("../src/native.cc", import.meta.url), "utf8");

    expect(source).toContain("\"premultiply\"");
    expect(source).toContain("alpha_premultiplied");
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

  test("rejects a codec-shaped addon that still reports a stub identity", () => {
    expect(() =>
      createNativeCodecFacade({
        version: () => "0.1.0-scaffold",
        probe: () => ({ loaded: true, path: "source stub" }),
        createDecoder: () => ({}) as never,
        createEncoder: () => ({}) as never,
      }),
    ).toThrow(CapabilityMissing);
  });

  test("loader throws CapabilityMissing when explicit addon paths are unavailable", () => {
    expect(() =>
      loadNativeBinding({
        prebuiltPath: "C:\\missing\\jxl-native-prebuilt.node",
        sourcePath: "C:\\missing\\jxl-native-source.node",
      }),
    ).toThrow(CapabilityMissing);
  });
});
