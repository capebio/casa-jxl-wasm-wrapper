import { expect, test } from 'bun:test';
import { analyzeProgressiveFrame, formatFrameStatsCompact, formatFrameStatsLog } from './jxl-progressive-frame-stats.js';

test('analyzeProgressiveFrame reports alpha, rgb, luma variance, and stable hash', () => {
    const pixels = new Uint8Array([
        0, 0, 0, 0,
        10, 20, 30, 255,
        10, 20, 30, 0,
        250, 250, 250, 128,
    ]);

    const stats = analyzeProgressiveFrame(pixels, 2, 2);

    expect(stats.alphaMin).toBe(0);
    expect(stats.alphaMax).toBe(255);
    expect(stats.alphaZeroPct).toBe(50);
    expect(stats.rgbNonzeroCount).toBe(9);
    expect(stats.lumaVariance).toBeGreaterThan(8000);
    expect(stats.frameHash).toMatch(/^[0-9a-f]{8}$/);
    expect(stats.pixelCount).toBe(4);
});

test('frame stats formatting includes measurement field names', () => {
    const stats = analyzeProgressiveFrame(new Uint8Array([1, 2, 3, 0]), 1, 1);

    expect(formatFrameStatsLog(stats)).toContain('alphaMin=0');
    expect(formatFrameStatsLog(stats)).toContain('alphaZeroPct=100.00');
    expect(formatFrameStatsCompact(stats)).toContain('hash=');
    expect(formatFrameStatsCompact(stats)).toContain('rgbNonzero=');
});
