// web/pyramid-filter-engine.test.js
// M2 unit tests per pyramid-gallery-m2-checklist.md §5.
// Bun runnable. Covers required assertions exactly (name completeness, safety, param validity).

import { expect, test } from "bun:test";
import createFilterEngine, { LightboxPreset, APPROVED_LIGHTBOX_PRESETS, APPROVED_SLIDERS } from "./pyramid-filter-engine.js";

test("name completeness: all 12 approved presets exist and match LightboxPreset", () => {
  expect(APPROVED_LIGHTBOX_PRESETS.length).toBe(12);
  expect(APPROVED_LIGHTBOX_PRESETS).toContain(LightboxPreset.NONE);
  expect(APPROVED_LIGHTBOX_PRESETS).toContain(LightboxPreset.BW);
  expect(APPROVED_LIGHTBOX_PRESETS).toContain(LightboxPreset.BW_HIGH);
  expect(APPROVED_LIGHTBOX_PRESETS).toContain(LightboxPreset.BW_SOFT);
  expect(APPROVED_LIGHTBOX_PRESETS).toContain(LightboxPreset.SEPIA);
  expect(APPROVED_LIGHTBOX_PRESETS).toContain(LightboxPreset.INVERT);
  expect(APPROVED_LIGHTBOX_PRESETS).toContain(LightboxPreset.BOTANICAL);
  expect(APPROVED_LIGHTBOX_PRESETS).toContain(LightboxPreset.WARM);
  expect(APPROVED_LIGHTBOX_PRESETS).toContain(LightboxPreset.COOL);
  expect(APPROVED_LIGHTBOX_PRESETS).toContain(LightboxPreset.DEHAZE);
  expect(APPROVED_LIGHTBOX_PRESETS).toContain(LightboxPreset.BLUEPRINT);
  expect(APPROVED_LIGHTBOX_PRESETS).toContain(LightboxPreset.CHLOROPHYLL);
});

test("preset safety: unsupported preset throws explicit error (no silent fail)", () => {
  const eng = createFilterEngine();
  expect(() => eng.setPreset("FAKE_PRESET")).toThrow(/Unsupported preset/);
  expect(() => eng.setPreset("")).toThrow();
  // valid ones do not throw
  eng.setPreset(LightboxPreset.BOTANICAL);
  eng.setPreset(LightboxPreset.NONE);
});

test("parameter validity: only the 8 approved sliders; values clamped to documented ranges", () => {
  const eng = createFilterEngine();

  // unknown rejected
  expect(() => eng.setParam("hue", 0.5)).toThrow(/Unknown slider/);
  expect(() => eng.setParam("exposure", 10)).toThrow();

  // valid keys accepted and clamped
  eng.setParam("brightness", 2); // >1 -> 1
  let p = eng.getParams();
  expect(p.brightness).toBe(1);

  eng.setParam("brightness", -2); // <-1 -> -1
  p = eng.getParams();
  expect(p.brightness).toBe(-1);

  eng.setParam("highlights", 0.5); // highlights must be <=0
  p = eng.getParams();
  expect(p.highlights).toBe(0); // clamped

  eng.setParam("shadows", -0.3); // shadows >=0
  p = eng.getParams();
  expect(p.shadows).toBe(0);

  eng.setParam("clarity", 1.5);
  p = eng.getParams();
  expect(p.clarity).toBe(1);

  eng.setParam("saturation", -0.7);
  p = eng.getParams();
  expect(p.saturation).toBe(-0.7);

  // all 8 exist in returned params
  for (const k of APPROVED_SLIDERS) {
    expect(p).toHaveProperty(k);
  }
});
