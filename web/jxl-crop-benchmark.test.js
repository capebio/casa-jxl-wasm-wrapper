import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./jxl-crop-benchmark.js', import.meta.url), 'utf8');

test('crop benchmark uses native region decode before target resize', () => {
    expect(source).toContain('async function decodeFullThenCrop(jxlBytes, sourceWidth, sourceHeight, targetSize, onMetric)');
    expect(source).toContain('region: { x, y, w, h },');
    expect(source).toContain('downsample: 1,');
});
