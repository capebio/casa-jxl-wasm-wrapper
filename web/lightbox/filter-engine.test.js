import { expect, test } from "bun:test";
import { createFilterEngine, LightboxPreset, APPROVED_LIGHTBOX_PRESETS, ADJUSTMENT_PARAMS } from "./filter-engine.js";

// node/bun polyfill for ImageData in unit test (no DOM)
if (typeof ImageData === "undefined") {
  globalThis.ImageData = class {
    constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
  };
}

test("filter-engine name completeness and enum match", () => {
  expect(APPROVED_LIGHTBOX_PRESETS.length).toBe(12);
  for (const p of APPROVED_LIGHTBOX_PRESETS) {
    expect(Object.values(LightboxPreset)).toContain(p);
  }
  // specific from checklist
  expect(LightboxPreset.BW_HIGH).toBe("BW_HIGH");
  expect(LightboxPreset.SEPIA).toBe("SEPIA");
  expect(LightboxPreset.INVERT).toBe("INVERT");
  expect(LightboxPreset.BOTANICAL).toBe("BOTANICAL");
  expect(LightboxPreset.DEHAZE).toBe("DEHAZE");
  expect(LightboxPreset.BLUEPRINT).toBe("BLUEPRINT");
  expect(LightboxPreset.CHLOROPHYLL).toBe("CHLOROPHYLL");
});

test("preset safety - throws on unsupported", () => {
  const eng = createFilterEngine();
  expect(() => eng.setPreset("FOO")).toThrow(/Unsupported preset/);
  expect(() => eng.setPreset("bad")).toThrow();
});

test("parameter validity - only approved, clamped", () => {
  const eng = createFilterEngine();
  for (const k of ADJUSTMENT_PARAMS) {
    eng.setParam(k, 50);
    expect(eng.getParams()[k]).toBe(50);
    eng.setParam(k, 999);
    expect(eng.getParams()[k]).toBe(100);
    eng.setParam(k, -999);
    expect(eng.getParams()[k]).toBe(-100);
  }
  expect(() => eng.setParam("foo", 0)).toThrow(/bad param/);
});

test("apply produces valid output and histogram updates", () => {
  const eng = createFilterEngine(LightboxPreset.SEPIA);
  eng.setParam("saturation", -100);
  const w=4, h=4;
  const data = new Uint8ClampedArray(w*h*4);
  for (let i=0; i<data.length; i+=4) { data[i]=128; data[i+1]=100; data[i+2]=80; data[i+3]=255; }
  const src = new ImageData(data, w, h);
  const out = eng.applyToImageData(src);
  expect(out.data.length).toBe(data.length);
  // after heavy desat on sepia should be near gray
  expect(out.data[0]).toBeGreaterThan(50);
  const hist = eng.computeHistogram(out.data);
  expect(hist.r.length).toBe(256);
  expect(hist.l[128]).toBeGreaterThan(0);
});

test("saturation does not double-count the matrix bias offset", () => {
  // DEHAZE carries a constant bias of 0.02 in every offset column. getMatrix() always
  // runs the saturation step (factor=1 at saturation=0, i.e. identity), so the offset
  // column must remain the preset bias exactly. The old code seeded the sat matrix's
  // offset from the incoming matrix, so compose() re-mixed and re-added the bias
  // (0.02 -> ~0.04). The saturation step must carry the prior offset through once.
  const eng = createFilterEngine(LightboxPreset.DEHAZE); // all sliders 0
  const m = eng.getMatrix();
  expect(m[3]).toBeCloseTo(0.02, 6);
  expect(m[7]).toBeCloseTo(0.02, 6);
  expect(m[11]).toBeCloseTo(0.02, 6);

  // Identity / no-sat case for a zero-bias preset must remain the identity matrix.
  const idEng = createFilterEngine(LightboxPreset.NONE);
  const id = idEng.getMatrix();
  const expected = [1,0,0,0, 0,1,0,0, 0,0,1,0];
  for (let k = 0; k < 12; k++) expect(id[k]).toBeCloseTo(expected[k], 6);
});