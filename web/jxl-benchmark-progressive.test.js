import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./jxl-benchmark.js', import.meta.url), 'utf8');

test('benchmark decoder passes explicit null region to avoid facade undefined-region crash', () => {
    expect(source).toContain("const decoder = createDecoder({");
    expect(source).toContain("region: null,");
    expect(source).toContain("downsample: opts.downsample,");
    expect(source).toContain("emitEveryPass: false,");
});
