import { describe, expect, test } from "bun:test";
import { CapabilityMissing, createDecoder, createEncoder } from "../src/index";

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

describe("@casabio/jxl-wasm facade", () => {
  test("decoder reports CapabilityMissing until generated WASM glue is installed", async () => {
    const decoder = createDecoder(decodeOptions);

    const first = await decoder.events()[Symbol.asyncIterator]().next();

    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({
      type: "error",
      code: "CapabilityMissing",
    });
    await decoder.dispose();
  });

  test("encoder chunks fail with CapabilityMissing until generated WASM glue is installed", async () => {
    const encoder = createEncoder(encodeOptions);

    await expect(encoder.chunks()[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(CapabilityMissing);
    await encoder.dispose();
  });
});
