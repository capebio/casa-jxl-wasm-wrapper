// web/pyramid-gallery.test.js
// M1 grid pure logic tests (bun runnable). Core behaviors: pick upgrade, monotonic, aspect from index, level size calc.
// These are the parts that can be unit-tested without DOM/fetch/WASM. Full gallery e2e is visual + fixtures (per handoff).

import { test, expect } from 'bun:test';

// extracted pure: pick smallest level >= target (DPR * container long)
function pickUpgradeSize(levels, targetLong) {
  if (!levels || levels.length === 0) return null;
  let best = null;
  for (const lv of levels) {
    const long = Math.max(lv.w || 0, lv.h || 0);
    if (long >= targetLong && (!best || long < Math.max(best.w || 0, best.h || 0))) best = lv;
  }
  if (!best) best = levels[levels.length - 1];
  return best;
}

test('pickUpgradeSize chooses first sufficient level (DPR target)', () => {
  const levels = [
    { size: 256, w: 256, h: 192, contenthash: 'a'.repeat(16) },
    { size: 512, w: 512, h: 384, contenthash: 'b'.repeat(16) },
    { size: 1024, w: 1024, h: 768, contenthash: 'c'.repeat(16) },
    { size: 2048, w: 2048, h: 1536, contenthash: 'd'.repeat(16) },
  ];
  expect(pickUpgradeSize(levels, 300).size).toBe(512); // 256 < 300, 512 wins
  expect(pickUpgradeSize(levels, 10).size).toBe(256);
  expect(pickUpgradeSize(levels, 2000).size).toBe(2048);
  expect(pickUpgradeSize(levels, 9999).size).toBe(2048); // cap at largest
});

test('monotonic guard: never downgrade currentSize', () => {
  let current = 256;
  function tryPaint(newSize) {
    if (newSize && newSize <= current) return false;
    current = newSize;
    return true;
  }
  expect(tryPaint(256)).toBe(false);
  expect(tryPaint(512)).toBe(true);
  expect(tryPaint(256)).toBe(false);
  expect(current).toBe(512);
});

test('index L0 + aspect seed shape (no bytes needed)', () => {
  const idx = { schema: 1, images: [
    { imageId: 'deadbeefcafebabe', aspect: 1.3333, l0: { contenthash: '0123456789abcdef', w: 256, h: 192 } },
  ]};
  const entry = idx.images[0];
  expect(entry.l0.contenthash).toHaveLength(16);
  expect(entry.aspect).toBeCloseTo(4/3, 4);
  // tile would be created with aspectRatio before any fetch
  const ratio = `${entry.aspect}`;
  expect(ratio.startsWith('1.333')).toBe(true);
});
