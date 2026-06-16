import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { contentHash16, imageIdForPath } from "../src/hash";

test("contentHash16 is the first 16 hex chars of SHA-256", () => {
  expect(contentHash16(new Uint8Array(0))).toBe("e3b0c44298fc1c14");
  expect(contentHash16(new Uint8Array(0))).toHaveLength(16);
});

test("contentHash16 is deterministic and content-sensitive", () => {
  const a = contentHash16(new Uint8Array([1, 2, 3]));
  const b = contentHash16(new Uint8Array([1, 2, 3]));
  const c = contentHash16(new Uint8Array([1, 2, 4]));
  expect(a).toBe(b);
  expect(a).not.toBe(c);
});

test("imageIdForPath normalizes the path so equivalent spellings collide", () => {
  const id1 = imageIdForPath("a/b/master.orf");
  const id2 = imageIdForPath("a/./b/master.orf");
  expect(id1).toBe(id2);
  expect(id1).toHaveLength(16);
  expect(imageIdForPath(resolve("a/b/master.orf"))).toBe(id1);
});