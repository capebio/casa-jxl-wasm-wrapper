import { expect, test } from "bun:test";
import { pickByteEndForQuality, type QualityCurvePoint } from "../src/manifest.js";

const curve: QualityCurvePoint[] = [
  { bytes: 1024, ssim: 0.95, butteraugli: 4.0 },
  { bytes: 4096, ssim: 0.998, butteraugli: 1.8 },
  { bytes: 16384, ssim: 0.9996, butteraugli: 1.05 },
];

test("picks the first curve point meeting a butteraugli threshold", () => {
  const level = { qualityCurve: curve, bytes: 65536 };
  expect(pickByteEndForQuality(level, { maxButteraugli: 2.0 })).toBe(4096);
  expect(pickByteEndForQuality(level, { maxButteraugli: 1.1 })).toBe(16384);
});

test("picks the first curve point meeting an ssim threshold", () => {
  const level = { qualityCurve: curve, bytes: 65536 };
  expect(pickByteEndForQuality(level, { minSsim: 0.998 })).toBe(4096);
});

test("requires every provided threshold on the same point", () => {
  const level = { qualityCurve: curve, bytes: 65536 };
  // butteraugli<=4.0 met at 1024, but ssim>=0.998 only at 4096 — combined picks 4096
  expect(pickByteEndForQuality(level, { maxButteraugli: 4.0, minSsim: 0.998 })).toBe(4096);
});

test("points missing a thresholded metric do not qualify", () => {
  const sparse: QualityCurvePoint[] = [
    { bytes: 512, ssim: 0.9999 },           // no butteraugli — cannot satisfy a butteraugli target
    { bytes: 2048, ssim: 0.9999, butteraugli: 1.0 },
  ];
  expect(pickByteEndForQuality({ qualityCurve: sparse, bytes: 65536 }, { maxButteraugli: 1.1 })).toBe(2048);
});

test("returns undefined when no point meets the threshold (download full level)", () => {
  const level = { qualityCurve: curve, bytes: 65536 };
  expect(pickByteEndForQuality(level, { maxButteraugli: 0.5 })).toBeUndefined();
});

test("returns undefined when the qualifying point would not truncate the download", () => {
  const level = { qualityCurve: curve, bytes: 16384 }; // qualifying point == total bytes
  expect(pickByteEndForQuality(level, { maxButteraugli: 1.1 })).toBeUndefined();
});

test("empty target falls back to convergedByteEnd, gated to truncating values", () => {
  expect(pickByteEndForQuality({ convergedByteEnd: 16384, bytes: 65536 })).toBe(16384);
  expect(pickByteEndForQuality({ convergedByteEnd: 65536, bytes: 65536 })).toBeUndefined();
  expect(pickByteEndForQuality({ bytes: 65536 })).toBeUndefined();
});

test("thresholds without a curve return undefined (no silent quality substitution)", () => {
  expect(pickByteEndForQuality({ convergedByteEnd: 16384, bytes: 65536 }, { maxButteraugli: 2.0 })).toBeUndefined();
});
