import { expect, test } from "bun:test";
import {
  levelSize,
  toEntry,
  buildManifest,
  buildIndexEntry,
  isUpToDate,
  type LevelEntry,
} from "../src/manifest";
import { parseManifest } from "../src/schema";

test("levelSize reports 'full' only when dims match the master", () => {
  expect(levelSize(4624, 3468, 4624, 3468)).toBe("full");
  expect(levelSize(256, 192, 4624, 3468)).toBe(256);
  expect(levelSize(192, 256, 4624, 3468)).toBe(256);
});

test("toEntry records tiled=true when the level bytes are a JXTC container", () => {
  const e = toEntry({ data: new Uint8Array(9), width: 10, height: 10, tiled: true }, 10, 10);
  expect(e.tiled).toBe(true);
});

test("toEntry builds an 8-bit, untiled level entry with a content hash", () => {
  const data = new Uint8Array([9, 8, 7, 6]);
  const e = toEntry({ data, width: 256, height: 192 }, 4624, 3468);
  expect(e.size).toBe(256);
  expect(e.w).toBe(256);
  expect(e.h).toBe(192);
  expect(e.bytes).toBe(4);
  expect(e.bitsPerSample).toBe(8);
  expect(e.tiled).toBe(false);
  expect(e.contenthash).toHaveLength(16);
});

test("buildManifest sorts levels ascending by pixel count and rounds aspect to 4dp", () => {
  const big: LevelEntry = { size: "full", w: 4624, h: 3468, bytes: 9, bitsPerSample: 8, contenthash: "f".repeat(16), tiled: false };
  const small: LevelEntry = { size: 256, w: 256, h: 192, bytes: 3, bitsPerSample: 8, contenthash: "a".repeat(16), tiled: false };
  const m = buildManifest({
    imageId: "9f86d081884c7d65",
    master: { name: "P2200566.ORF", format: "orf", mtimeMs: 1717689600000 },
    orientation: "baked",
    width: 4624,
    height: 3468,
    levels: [big, small],
  });
  expect(m.schema).toBe(1);
  expect(m.levels.map((l) => l.size)).toEqual([256, "full"]);
  expect(m.aspect).toBeCloseTo(1.3333, 4);
  expect(m.proxy).toBeUndefined();
});

test("buildManifest flags proxy and buildIndexEntry inlines L0", () => {
  const small: LevelEntry = { size: 512, w: 512, h: 384, bytes: 3, bitsPerSample: 8, contenthash: "b".repeat(16), tiled: false };
  const proxy = buildManifest({
    imageId: "a".repeat(16), master: { name: "x.jpg", format: "jpg", mtimeMs: 1 },
    orientation: "source", width: 4000, height: 3000, levels: [small], proxy: true,
  });
  expect(proxy.proxy).toBe(true);
  expect(proxy.orientation).toBe("source");

  const idx = buildIndexEntry(proxy);
  expect(idx.imageId).toBe("a".repeat(16));
  expect(idx.l0).toEqual({ contenthash: "b".repeat(16), w: 512, h: 384 });
});

test("isUpToDate requires a matching mtime and a non-proxy manifest", () => {
  const base = buildManifest({
    imageId: "b".repeat(16), master: { name: "x.orf", format: "orf", mtimeMs: 1000 },
    orientation: "baked", width: 10, height: 10,
    levels: [{ size: "full", w: 10, h: 10, bytes: 1, bitsPerSample: 8, contenthash: "c".repeat(16), tiled: false }],
  });
  expect(isUpToDate(base, 1000)).toBe(true);
  // low-mtime-rounding: exact match (dropped round); 1000.4 no longer matches
  expect(isUpToDate(base, 1000.4)).toBe(false);
  expect(isUpToDate(base, 2000)).toBe(false);
  expect(isUpToDate({ ...base, proxy: true }, 1000)).toBe(false);
});

test("buildManifest produces producedBy and manifestSchemaV1 roundtrips it", () => {
  const m = buildManifest({
    imageId: "9f86d081884c7d65",
    master: { name: "P2200566.ORF", format: "orf", mtimeMs: 1717689600000 },
    orientation: "baked",
    width: 4624,
    height: 3468,
    levels: [{ size: "full", w: 4624, h: 3468, bytes: 9, bitsPerSample: 8, contenthash: "f".repeat(16), tiled: false }],
  });
  expect(m.producedBy?.tool).toBe("pyramid-ingest");
  expect(m.producedBy?.version).toBe("0.1.0");
  expect(m.producedBy?.encoder.effort).toBe(3);
  const reparsed = parseManifest(JSON.stringify(m));
  expect(reparsed.producedBy).toEqual(m.producedBy);
});

test("manifestSchemaV1 / parseManifest rejects bad numeric aspect (div0, NaN, non-positive, Inf)", () => {
  const base = buildManifest({
    imageId: "9f86d081884c7d65",
    master: { name: "t.orf", format: "orf", mtimeMs: 1 },
    orientation: "baked", width: 10, height: 10,
    levels: [{ size: "full", w: 10, h: 10, bytes: 1, bitsPerSample: 8, contenthash: "a".repeat(16), tiled: false }],
  });
  const bads = [
    { ...base, aspect: 0 },
    { ...base, aspect: -1 },
    { ...base, aspect: NaN },
    { ...base, aspect: Infinity },
  ];
  for (const b of bads) {
    expect(() => parseManifest(JSON.stringify(b))).toThrow();
  }
});

test("manifestSchemaV1 / parseManifest rejects non-hex imageId", () => {
  const base = buildManifest({
    imageId: "9f86d081884c7d65",
    master: { name: "t.orf", format: "orf", mtimeMs: 1 },
    orientation: "baked", width: 10, height: 10,
    levels: [{ size: "full", w: 10, h: 10, bytes: 1, bitsPerSample: 8, contenthash: "a".repeat(16), tiled: false }],
  });
  expect(() => parseManifest(JSON.stringify({ ...base, imageId: "zzzzzzzzzzzzzzzz" }))).toThrow();
  expect(() => parseManifest(JSON.stringify({ ...base, imageId: "short" }))).toThrow();
});

test("parseManifest (B10) rejects unknown major producedBy version cleanly", () => {
  const base = buildManifest({
    imageId: "9f86d081884c7d65",
    master: { name: "t.orf", format: "orf", mtimeMs: 1 },
    orientation: "baked", width: 10, height: 10,
    levels: [{ size: "full", w: 10, h: 10, bytes: 1, bitsPerSample: 8, contenthash: "a".repeat(16), tiled: false }],
  });
  const bad = {
    ...base,
    producedBy: { ...base.producedBy!, version: "999.0.0" },
  };
  expect(() => parseManifest(JSON.stringify(bad))).toThrow();
});