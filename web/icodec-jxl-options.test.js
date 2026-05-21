import { expect, test } from 'bun:test';
import { buildIcodecJxlOptions } from './icodec-jxl-options.js';

test('uses DC-only progressive options for large libjxl encodes', () => {
    const opts = buildIcodecJxlOptions({
        quality: 90,
        effort: 3,
        lossless: false,
        progressive: true,
        width: 5240,
        height: 3912,
    });

    expect(opts.progressiveDC).toBe(1);
    expect(opts.progressiveAC).toBe(0);
    expect(opts.qProgressiveAC).toBe(0);
});

test('keeps AC progressive options for small libjxl encodes', () => {
    const opts = buildIcodecJxlOptions({
        quality: 90,
        effort: 3,
        lossless: false,
        progressive: true,
        width: 800,
        height: 597,
    });

    expect(opts.progressiveDC).toBe(1);
    expect(opts.progressiveAC).toBe(1);
    expect(opts.qProgressiveAC).toBe(1);
});

test('can force DC-only or AC progressive options explicitly', () => {
    const dc = buildIcodecJxlOptions({
        quality: 90,
        effort: 3,
        lossless: false,
        progressive: true,
        progressiveFlavor: 'dc',
        width: 800,
        height: 597,
    });
    const ac = buildIcodecJxlOptions({
        quality: 90,
        effort: 3,
        lossless: false,
        progressive: true,
        progressiveFlavor: 'ac',
        width: 5240,
        height: 3912,
    });

    expect(dc.progressiveAC).toBe(0);
    expect(dc.qProgressiveAC).toBe(0);
    expect(ac.progressiveAC).toBe(1);
    expect(ac.qProgressiveAC).toBe(1);
});
