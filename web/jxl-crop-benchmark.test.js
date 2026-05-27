import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./jxl-crop-benchmark.js', import.meta.url), 'utf8');

test('crop benchmark picks native decode downsample from source dims before target resize', () => {
    expect(source).toContain('function pickDecodeDownsample(sourceWidth, sourceHeight, targetLongEdge)');
    expect(source).toContain("downsample: pickDecodeDownsample(sourceWidth, sourceHeight, targetSize),");
});
