import { describe, test, expect } from 'bun:test';
import { chooseLevelForTarget, shouldUpgrade } from '../packages/jxl-pyramid/dist/choose-level.js';

describe('tauri pyramid level picker (PR-8b)', () => {
  const levels = [
    { w: 256, h: 192, contenthash: 'a'.repeat(16) },
    { w: 512, h: 384, contenthash: 'b'.repeat(16) },
    { w: 1024, h: 768, contenthash: 'c'.repeat(16) },
  ];

  test('chooseLevelForTarget picks smallest level >= target long edge', () => {
    const target = Math.ceil(360 * 1);
    const pick = chooseLevelForTarget(levels, target);
    expect(pick?.w).toBe(512);
  });

  test('shouldUpgrade is monotonic by pixel count', () => {
    expect(shouldUpgrade(levels[0], levels[1])).toBe(true);
    expect(shouldUpgrade(levels[2], levels[1])).toBe(false);
  });
});