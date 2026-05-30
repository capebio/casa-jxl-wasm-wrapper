import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('progressive page imports the wasm bundle from the repo pkg directory', () => {
    const source = readFileSync(new URL('./jxl-progressive.js', import.meta.url), 'utf8');
    expect(source).toContain("from './pkg/raw_converter_wasm.js'");
});
