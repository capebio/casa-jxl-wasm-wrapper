import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./jxl-benchmark.js', import.meta.url), 'utf8');

test('progressive paint decoders pass explicit null region to avoid facade undefined-region crash', () => {
    expect(source).toContain("const decoder = createDecoder({");
    expect(source).toContain("const decoder2 = createDecoder({");
    expect(source).toContain("region: null,");
    expect(source).toContain("downsample: 1,");
    expect(source).toContain("emitEveryPass: true,");
    expect(source).toContain("emitEveryPass: false,");
});
