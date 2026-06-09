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

// G4-E: custom property-based (random levels with increasing long edges)
test("chooseLevelForTarget properties (random monotonic levels)", () => {
  for (let i = 0; i < 50; i++) {
    // generate 3-5 levels with strictly increasing longEdge
    const n = 3 + Math.floor(Math.random() * 3);
    const genLevels = [];
    let prevLong = 0;
    for (let j = 0; j < n; j++) {
      const w = Math.floor(Math.random() * 4000) + 100;
      const h = Math.floor(Math.random() * 3000) + 100;
      const longE = Math.max(w, h);
      if (longE <= prevLong) { j--; continue; }
      prevLong = longE;
      genLevels.push({
        size: j === n-1 ? "full" : (256 << j),
        w, h,
        bytes: 1000 * (j+1),
        bitsPerSample: 8,
        contenthash: "p".repeat(16),
        tiled: false,
      });
    }
    // pick random target
    const target = Math.floor(Math.random() * (prevLong * 2));
    const pick = chooseLevelForTarget(genLevels, target);
    if (!pick) continue;
    // must be the smallest long >= target, or the largest
    const longs = genLevels.map(l => Math.max(l.w, l.h));
    const idx = genLevels.indexOf(pick);
    const pLong = Math.max(pick.w, pick.h);
    if (pLong >= target) {
      // verify no smaller one >= target
      for (let k=0; k<idx; k++) {
        expect(Math.max(genLevels[k].w, genLevels[k].h)).toBeLessThan(target);
      }
    } else {
      // must be last
      expect(idx).toBe(genLevels.length-1);
    }
  }
});