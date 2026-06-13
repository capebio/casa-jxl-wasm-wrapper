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

test('analyzeProgressiveFrame handles zero dims + empty buffer', () => {
    const s = analyzeProgressiveFrame(new Uint8Array(0), 0, 0);
    expect(s.pixelCount).toBe(0);
    expect(s.alphaMin).toBe(0);
    expect(s.alphaZeroPct).toBe(0);
    expect(s.frameHash).toMatch(/^[0-9a-f]{8}$/);
});

test('analyzeProgressiveFrame handles truncated buffer (partial pixels)', () => {
    const buf = new Uint8Array([10,20,30,255, 40,50,60]); // 1 full + partial
    const s = analyzeProgressiveFrame(buf, 2, 2);
    expect(s.pixelCount).toBe(4);
    expect(s.alphaMax).toBe(255);
    expect(s.rgbNonzeroCount).toBeGreaterThanOrEqual(3);
});

test('analyzeProgressiveFrame hash differs on content, stable on same', () => {
    const a = analyzeProgressiveFrame(new Uint8Array([1,2,3,4]), 1, 1).frameHash;
    const b = analyzeProgressiveFrame(new Uint8Array([1,2,3,5]), 1, 1).frameHash;
    expect(a).not.toBe(b);
    expect(analyzeProgressiveFrame(new Uint8Array([1,2,3,4]), 1, 1).frameHash).toBe(a);
});
