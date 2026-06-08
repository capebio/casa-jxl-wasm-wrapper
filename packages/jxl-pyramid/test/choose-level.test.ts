import { expect, test } from "bun:test";
import { chooseLevelForTarget, shouldUpgrade } from "../src/choose-level.js";

const levels = [
  { size: 256, w: 256, h: 192, bytes: 1, bitsPerSample: 8 as const, contenthash: "a".repeat(16), tiled: false },
  { size: 1024, w: 1024, h: 768, bytes: 2, bitsPerSample: 8 as const, contenthash: "b".repeat(16), tiled: false },
  { size: "full" as const, w: 4000, h: 3000, bytes: 3, bitsPerSample: 8 as const, contenthash: "c".repeat(16), tiled: false },
];

test("chooseLevelForTarget picks smallest level >= target long edge", () => {
  expect(chooseLevelForTarget(levels, 600)?.size).toBe(1024);
  expect(chooseLevelForTarget(levels, 200)?.size).toBe(256);
  expect(chooseLevelForTarget(levels, 5000)?.size).toBe("full");
});

test("shouldUpgrade is monotonic by pixel count", () => {
  expect(shouldUpgrade(levels[0]!, levels[1]!)).toBe(true);
  expect(shouldUpgrade(levels[1]!, levels[0]!)).toBe(false);
});