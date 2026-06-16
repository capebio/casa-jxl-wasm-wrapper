import { expect, test } from "bun:test";
import {
  qualityToDistance,
  planLadder,
  planProxy,
  EFFORT,
  LEVEL_SIZES,
  GRID_QUALITY,
  BIG_QUALITY,
} from "../src/quality";

test("qualityToDistance follows libjxl 0.1 + (100-q)*0.09", () => {
  expect(qualityToDistance(85)).toBeCloseTo(1.45, 5);
  expect(qualityToDistance(95)).toBeCloseTo(0.55, 5);
  expect(qualityToDistance(100)).toBe(0);
});

test("qualityToDistance clamps to int (low-quality-discontinuity)", () => {
  expect(qualityToDistance(99.6)).toBe(0);
  // after clamp+round: 99.4 -> 99 -> 0.1 +1*0.09 = 0.19
  expect(qualityToDistance(99.4)).toBeCloseTo(0.19, 3);
});

test("qualityToDistance rejects q below the libjxl-defined range", () => {
  expect(() => qualityToDistance(29)).toThrow();
});

test("qualityToDistance rejects q > 100", () => {
  expect(() => qualityToDistance(101)).toThrow(/out of range/);
  expect(() => qualityToDistance(100.1)).toThrow();
});

test("planLadder pairs grid sizes with q85 and the 2048 big level with q95", () => {
  const plan = planLadder();
  expect(plan.sidecars.map((s) => s.size)).toEqual([...LEVEL_SIZES]);
  expect(plan.effort).toBe(EFFORT);
  expect(plan.sidecars.length).toBe(LEVEL_SIZES.length);
  expect(plan.sidecars[0]!.distance).toBeCloseTo(qualityToDistance(GRID_QUALITY), 5);
  expect(plan.sidecars[2]!.distance).toBeCloseTo(qualityToDistance(GRID_QUALITY), 5);
  expect(plan.sidecars[3]!.distance).toBeCloseTo(qualityToDistance(BIG_QUALITY), 5);
  expect(plan.fullDistance).toBeCloseTo(qualityToDistance(BIG_QUALITY), 5);
});

test("planLadder(masterLong) filters to meaningful targets only (Q1)", () => {
  // master 3000: 2048 is <3000 but 3000/2048 ~1.46 >1.15 → keep; 1024 etc keep
  const p3k = planLadder(3000);
  expect(p3k.sidecars.map(s => s.size)).toEqual([256,512,1024,2048]);

  // master 2200: 2048/2200 wait, 2200/2048~1.07 <1.15 → drop 2048 as near-full redundant
  const p22 = planLadder(2200);
  expect(p22.sidecars.map(s => s.size)).toEqual([256,512,1024]);

  // master=500: 256 <500 and 500/256~1.95>=1.15 → keep 256 only
  const p500 = planLadder(500);
  expect(p500.sidecars.map(s => s.size)).toEqual([256]);

  // master=200: 256 not <200 → empty
  const p200 = planLadder(200);
  expect(p200.sidecars).toEqual([]);
});

test("planProxy emits a single q85 level at the requested size", () => {
  const plan = planProxy(512);
  expect(plan.sidecars.map((s) => s.size)).toEqual([512]);
  expect(plan.sidecars[0]!.distance).toBeCloseTo(qualityToDistance(85), 5);
  expect(plan.fullDistance).toBeCloseTo(qualityToDistance(85), 5);
  expect(plan.effort).toBe(EFFORT);
});