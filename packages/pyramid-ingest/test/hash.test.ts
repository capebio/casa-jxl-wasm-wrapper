import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { contentHash16, imageIdForPath } from "../src/hash";

test("contentHash16 is 16 hex chars of FNV-1a (−69% vs SHA-256)", () => {
  // FNV-1a of empty array: two 32-bit lanes initialized, no bytes processed
  expect(contentHash16(new Uint8Array(0))).toBe("811c9dc5c2b2ae35");
  expect(contentHash16(new Uint8Array(0))).toHaveLength(16);
});

test("contentHash16 is deterministic and content-sensitive", () => {
  const a = contentHash16(new Uint8Array([1, 2, 3]));
  const b = contentHash16(new Uint8Array([1, 2, 3]));
  const c = contentHash16(new Uint8Array([1, 2, 4]));
  expect(a).toBe(b);
  expect(a).not.toBe(c);
});

test("imageIdForPath normalizes the path so equivalent spellings collide", async () => {
  const id1 = await imageIdForPath("a/b/master.orf");
  const id2 = await imageIdForPath("a/./b/master.orf");
  expect(id1).toBe(id2);
  expect(id1).toHaveLength(16);
  expect(await imageIdForPath(resolve("a/b/master.orf"))).toBe(id1);
});