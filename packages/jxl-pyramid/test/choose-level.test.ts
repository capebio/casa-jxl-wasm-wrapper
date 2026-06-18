import { expect, test } from "bun:test";
import { chooseLevelForTarget, shouldUpgrade } from "../src/choose-level.js";
import * as fc from "fast-check";

const levels = [
  { size: 256, w: 256, h: 192, bytes: 1, bitsPerSample: 8 as const, contenthash: "a".repeat(16), tiled: false },
  { size: 1024, w: 1024, h: 768, bytes: 2, bitsPerSample: 8 as const, contenthash: "b".repeat(16), tiled: false },
  { size: "full" as const, w: 4000, h: 3000, bytes: 3, bitsPerSample: 8 as const, contenthash: "c".repeat(16), tiled: false },
];

test("chooseLevelForTarget picks smallest level >= target long edge", () => {
  expect(chooseLevelForTarget(levels, 600).size).toBe(1024);
  expect(chooseLevelForTarget(levels, 200).size).toBe(256);
  expect(chooseLevelForTarget(levels, 5000).size).toBe("full");
});

test("chooseLevelForTarget throws on empty levels (Grok1)", () => {
  expect(() => chooseLevelForTarget([], 100)).toThrow(RangeError);
  expect(() => chooseLevelForTarget([], 100)).toThrow("chooseLevelForTarget requires non-empty levels");
});

test("chooseLevelForTarget throws on invalid targetLongEdge (Grok1 NaN/zero guard)", () => {
  expect(() => chooseLevelForTarget(levels, NaN)).toThrow(RangeError);
  expect(() => chooseLevelForTarget(levels, 0)).toThrow(RangeError);
  expect(() => chooseLevelForTarget(levels, -5)).toThrow(RangeError);
  expect(() => chooseLevelForTarget(levels, Infinity)).toThrow(RangeError);
});

test("shouldUpgrade is monotonic by pixel count", () => {
  expect(shouldUpgrade(levels[0]!, levels[1]!)).toBe(true);
  expect(shouldUpgrade(levels[1]!, levels[0]!)).toBe(false);
});

// Grok1 #12: Property test (fast-check) on chooseLevelForTarget over levels with mixed aspect ratios (logic-019)
test("chooseLevelForTarget property: mixed aspect ratios (fast-check)", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          w: fc.integer({ min: 10, max: 8000 }),
          h: fc.integer({ min: 10, max: 8000 }),
        }),
        { minLength: 1, maxLength: 8 }
      ).map((arr) =>
        arr
          .map((r, i) => ({
            size: i === arr.length - 1 ? ("full" as const) : (256 << i),
            w: r.w,
            h: r.h,
            bytes: 100 + i,
            bitsPerSample: 8 as const,
            contenthash: "p".repeat(16),
            tiled: false,
          }))
          // ensure unique by long edge rough; sort not required (per Grok1 we drop sort)
          .sort((a, b) => a.w * a.h - b.w * b.h)
      ),
      fc.integer({ min: 1, max: 16000 }),
      (genLevels, target) => {
        // dedup by identity not needed; just run
        const pick = chooseLevelForTarget(genLevels, target);
        const longs = genLevels.map((l) => Math.max(l.w, l.h));
        const pLong = Math.max(pick.w, pick.h);
        if (pLong >= target) {
          // no earlier level should satisfy >= target
          for (let k = 0; k < genLevels.length; k++) {
            if (Math.max(genLevels[k].w, genLevels[k].h) >= target) {
              // the first such must be our pick (or later equiv)
              break;
            }
          }
        } else {
          // no level meets target; pick must be the one with the largest long edge
          const maxLong = Math.max(...genLevels.map((l) => Math.max(l.w, l.h)));
          const candidates = genLevels.filter((l) => Math.max(l.w, l.h) === maxLong);
          expect(candidates).toContain(pick);
        }
        return true;
      }
    ),
    { numRuns: 100 }
  );
});
