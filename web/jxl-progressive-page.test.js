import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./jxl-progressive.js', import.meta.url), 'utf8');

test('libjxl progressive stream path uses session chunks instead of blob decode fallback', () => {
    expect(source).not.toContain('decodeJxlBytes');
    expect(source).toContain('createProgressiveDecodeRequest');
    expect(source).toContain('request.push(chunk)');
    expect(source).toContain('transport-chunk-kb');
    expect(source).toContain('thumb-display-size');
    expect(source).toContain('wireSlideoutPanel');
});
