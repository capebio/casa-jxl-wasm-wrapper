import { expect, test } from "bun:test";
import { planShard, boundedConcurrency } from "../src/shard";

test("planShard round-robins files into a disjoint, complete partition", () => {
  const files = ["a", "b", "c", "d", "e"];
  const s0 = planShard(files, 0, 2);
  const s1 = planShard(files, 1, 2);
  expect(s0).toEqual(["a", "c", "e"]);
  expect(s1).toEqual(["b", "d"]);
  expect([...s0, ...s1].sort()).toEqual([...files].sort());
});

test("planShard with N=1 returns everything", () => {
  expect(planShard(["a", "b"], 0, 1)).toEqual(["a", "b"]);
});

test("planShard rejects an out-of-range index", () => {
  expect(() => planShard(["a"], 2, 2)).toThrow();
  expect(() => planShard(["a"], -1, 2)).toThrow();
  expect(() => planShard(["a"], 0, 0)).toThrow();
});

test("boundedConcurrency clamps to the tightest of cores, request, and memory", () => {
  const GB = 1024 * 1024 * 1024;
  expect(boundedConcurrency(8, undefined, 8 * GB, 800 * 1024 * 1024)).toBe(8);
  expect(boundedConcurrency(8, 2, 8 * GB, 800 * 1024 * 1024)).toBe(2);
  expect(boundedConcurrency(8, undefined, 1 * GB, 800 * 1024 * 1024)).toBe(1);
  expect(boundedConcurrency(0, 0, 0, 0)).toBe(1);
});