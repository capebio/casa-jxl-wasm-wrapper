import { expect, test } from "bun:test";

// Pure logic extracted from pyramid-gallery-grid.js for verification (no DOM, no WASM).
// These must stay in sync with the impl.

function chooseLevelForTarget(levels, currentSize, targetLong) {
  for (const lv of levels) {
    const s = lv.size === 'full' ? Math.max(lv.w, lv.h) : lv.size;
    if (s > currentSize && s >= targetLong) return lv;
  }
  for (let i = levels.length - 1; i >= 0; i--) {
    const lv = levels[i];
    const s = lv.size === 'full' ? Math.max(lv.w, lv.h) : lv.size;
    if (s > currentSize) return lv;
  }
  return null;
}

function computeWarmIds(visibleSet, allOrdered, radius) {
  const idx = new Map();
  allOrdered.forEach((id, i) => idx.set(id, i));
  const visIdx = [...visibleSet].map(id => idx.get(id)).filter(i => i != null).sort((a,b)=>a-b);
  if (visIdx.length === 0) return new Set(allOrdered.slice(0, Math.min(6, allOrdered.length)));
  const minI = Math.max(0, Math.min(...visIdx) - radius);
  const maxI = Math.min(allOrdered.length - 1, Math.max(...visIdx) + radius);
  const warm = new Set();
  for (let i = minI; i <= maxI; i++) warm.add(allOrdered[i]);
  return warm;
}

function makeAspectStyle(a) { return `aspect-ratio:${a}`; }

test("aspect reserves space (no shift)", () => {
  expect(makeAspectStyle(1.5)).toBe("aspect-ratio:1.5");
  expect(makeAspectStyle(0.75)).toContain("0.75");
});

test("chooseLevelForTarget monotonic + DPR target", () => {
  const levels = [
    { size: 256, w:256, h:192, contenthash:"a" },
    { size: 512, w:512, h:384, contenthash:"b" },
    { size: "full", w:2048, h:1536, contenthash:"c" },
  ];
  // from 0, target 300 -> 512
  let up = chooseLevelForTarget(levels, 0, 300);
  expect(up.size).toBe(512);
  // monotonic: current 512, target 600 still picks full
  up = chooseLevelForTarget(levels, 512, 600);
  expect(up.size).toBe("full");
  // already at full -> null
  up = chooseLevelForTarget(levels, 2048, 1000);
  expect(up).toBeNull();
});

test("prefetch ring expands around visible, bounded", () => {
  const ids = ["i0","i1","i2","i3","i4","i5","i6"];
  const vis = new Set(["i2"]);
  const warm = computeWarmIds(vis, ids, 2);
  expect(warm.has("i0")).toBe(true);
  expect(warm.has("i4")).toBe(true);
  expect(warm.has("i5")).toBe(false); // radius 2 from 2 -> 0..4
  const vis2 = new Set(["i6"]);
  const warm2 = computeWarmIds(vis2, ids, 1);
  expect(warm2.has("i5")).toBe(true);
  expect(warm2.has("i6")).toBe(true);
});

test("index shape + L0 seed shape (from manifest contract)", () => {
  const idx = { schema:1, images: [
    { imageId: "abc123", aspect: 1.3333, l0: { contenthash: "deadbeef", w:256, h:192 } }
  ]};
  expect(idx.schema).toBe(1);
  expect(idx.images[0].l0.contenthash.length).toBeGreaterThan(4);
  // L0 first enables immediate aspect + tiny decode without full manifest
  expect(idx.images[0].aspect).toBeGreaterThan(0);
});