import { expect, test } from "bun:test";
import { packedRgb16ToRgba16, targetDimsForLongEdge } from "../src/rgb16";

test("packedRgb16ToRgba16 expands 6-byte RGB to RGBA16 with full alpha", () => {
  const packed = new Uint8Array([0xff, 0x7f, 0x00, 0x40, 0x10, 0x20]);
  const out = packedRgb16ToRgba16(packed, 1, 1);
  expect(out[0]).toBe(0x7fff);
  expect(out[1]).toBe(0x4000);
  expect(out[2]).toBe(0x2010);
  expect(out[3]).toBe(65535);
});

test("targetDimsForLongEdge preserves aspect", () => {
  expect(targetDimsForLongEdge(4000, 3000, 2048)).toEqual({ w: 2048, h: 1536 });
  expect(targetDimsForLongEdge(3000, 4000, 2048)).toEqual({ w: 1536, h: 2048 });
});