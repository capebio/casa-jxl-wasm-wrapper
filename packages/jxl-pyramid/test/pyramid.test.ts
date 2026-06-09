// pyramid.test.ts
// Unit tests for @casabio/jxl-pyramid schemas, constants, and fixtures.
// Conforms strictly to the 2026-06-07-pyramid-gallery-design.md specification.

import { expect, test } from "bun:test";
import {
  PYRAMID_LEVEL_SIZES,
  PROXY_SIZES,
  DEFAULT_PROXY_SIZE,
  ALLOWED_FORMATS,
  ORIENTATION_VALUES,
  QUALITY_DISTANCES,
  QUALITY_TO_DISTANCE_MAP,
  MASSIVE_LONG_EDGE_THRESHOLD,
  MASSIVE_PIXEL_THRESHOLD,
  JXTC_TILE_SIZE,
  APPROVED_LIGHTBOX_PRESETS,
  LightboxPreset,
} from "../src/constants.js";
import { APPROVED_FIXTURES } from "../src/fixtures.js";
import type { PyramidManifest, GalleryIndex } from "../src/manifest.js";

test("Pyramid Constants Verification", () => {
  // Verify pyramid level sizes
  expect(PYRAMID_LEVEL_SIZES).toEqual([256, 512, 1024, 2048]);

  // Verify proxy sizes and defaults
  expect(PROXY_SIZES).toEqual([256, 512, 1024]);
  expect(DEFAULT_PROXY_SIZE).toBe(512);

  // Verify allowed formats and orientations
  expect(ALLOWED_FORMATS).toEqual(["orf", "dng", "cr2", "jpg"]);
  expect(ORIENTATION_VALUES).toEqual(["baked", "source"]);

  // Verify quality distance mappings
  expect(QUALITY_DISTANCES.GRID_PRESET_Q85).toBe(1.45);
  expect(QUALITY_DISTANCES.BIG_PRESET_Q95).toBe(0.55);
  expect(QUALITY_DISTANCES.LOSSLESS_D0).toBe(0.0);

  expect(QUALITY_TO_DISTANCE_MAP[85]).toBe(1.45);
  expect(QUALITY_TO_DISTANCE_MAP[95]).toBe(0.55);
  expect(QUALITY_TO_DISTANCE_MAP[100]).toBe(0.0);

  expect(MASSIVE_LONG_EDGE_THRESHOLD).toBe(8000);
  expect(MASSIVE_PIXEL_THRESHOLD).toBe(40_000_000);
  expect(JXTC_TILE_SIZE).toBe(512);
});

test("Lightbox Presets Verification", () => {
  // 12 approved presets must be present
  expect(APPROVED_LIGHTBOX_PRESETS.length).toBe(12);
  
  // Verify specific presets exist and match their expected string representation
  expect(LightboxPreset.BW).toBe("BW");
  expect(LightboxPreset.BW_HIGH).toBe("BW_HIGH");
  expect(LightboxPreset.BW_SOFT).toBe("BW_SOFT");
  expect(LightboxPreset.SEPIA).toBe("SEPIA");
  expect(LightboxPreset.INVERT).toBe("INVERT");
  expect(LightboxPreset.BOTANICAL).toBe("BOTANICAL");
  expect(LightboxPreset.WARM).toBe("WARM");
  expect(LightboxPreset.COOL).toBe("COOL");
  expect(LightboxPreset.DEHAZE).toBe("DEHAZE");
  expect(LightboxPreset.BLUEPRINT).toBe("BLUEPRINT");
  expect(LightboxPreset.CHLOROPHYLL).toBe("CHLOROPHYLL");
  expect(LightboxPreset.NONE).toBe("NONE");

  // Verify all enum keys are listed in approved list
  for (const preset of APPROVED_LIGHTBOX_PRESETS) {
    expect(Object.values(LightboxPreset)).toContain(preset);
  }
});

test("Test Fixtures Validation", () => {
  expect(APPROVED_FIXTURES.length).toBe(8);

  const formats = APPROVED_FIXTURES.map((f) => f.format);
  expect(formats).toContain("orf");
  expect(formats).toContain("dng");
  expect(formats).toContain("cr2");
  expect(formats).toContain("jpg");

  // Verify (now relative) paths are preserved as strings (G4-C removed absolutes)
  const cr2_1 = APPROVED_FIXTURES.find((f) => f.path.endsWith("_MG_1750.CR2"));
  expect(cr2_1).toBeDefined();
  expect(cr2_1!.path).toBe("tests/_MG_1750.CR2");

  const dng_1 = APPROVED_FIXTURES.find((f) => f.path.endsWith("180319603.RAW-02.ORIGINAL.dng"));
  expect(dng_1).toBeDefined();
  expect(dng_1!.path).toBe("tests/PXL_20260527_180319603.RAW-02.ORIGINAL.dng");
});

test("Type Definition Structural Compilability", () => {
  // Compile-time structural validation (types only)
  const manifest: PyramidManifest = {
    schema: 1,
    imageId: "test-image-id",
    master: {
      name: "P2200566.ORF",
      format: "orf",
      mtimeMs: 123456789,
    },
    orientation: "baked",
    width: 4000,
    height: 3000,
    aspect: 1.3333,
    levels: [
      {
        size: 256,
        w: 256,
        h: 192,
        bytes: 1024,
        bitsPerSample: 8,
        contenthash: "ab12cd34ef56gh78",
        tiled: false,
      },
      {
        size: "full",
        w: 4000,
        h: 3000,
        bytes: 512345,
        bitsPerSample: 8,
        contenthash: "bc23de45fg67hi89",
        tiled: false,
      },
    ],
  };

  const index: GalleryIndex = {
    schema: 1,
    images: [
      {
        imageId: "test-image-id",
        aspect: 1.3333,
        l0: {
          contenthash: "ab12cd34ef56gh78",
          w: 256,
          h: 192,
        },
      },
    ],
  };

  expect(manifest.schema).toBe(1);
  expect(index.schema).toBe(1);
});
