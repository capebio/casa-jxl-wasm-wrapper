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

test("qualityToDistance rejects q below the libjxl-defined range", () => {
  expect(() => qualityToDistance(29)).toThrow();
});

test("planLadder pairs grid sizes with q85 and the 2048 big level with q95", () => {
  const plan = planLadder();
  expect(plan.sidecarSizes).toEqual([...LEVEL_SIZES]);
  expect(plan.effort).toBe(EFFORT);
  expect(plan.sidecarDistances.length).toBe(plan.sidecarSizes.length);
  expect(plan.sidecarDistances[0]).toBeCloseTo(qualityToDistance(GRID_QUALITY), 5);
  expect(plan.sidecarDistances[2]).toBeCloseTo(qualityToDistance(GRID_QUALITY), 5);
  expect(plan.sidecarDistances[3]).toBeCloseTo(qualityToDistance(BIG_QUALITY), 5);
  expect(plan.fullDistance).toBeCloseTo(qualityToDistance(BIG_QUALITY), 5);
});

test("planProxy emits a single q85 level at the requested size", () => {
  const plan = planProxy(512);
  expect(plan.sidecarSizes).toEqual([512]);
  expect(plan.sidecarDistances[0]).toBeCloseTo(qualityToDistance(85), 5);
  expect(plan.fullDistance).toBeCloseTo(qualityToDistance(85), 5);
  expect(plan.effort).toBe(EFFORT);
});