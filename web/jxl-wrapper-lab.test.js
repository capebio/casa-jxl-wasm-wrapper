import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';

const htmlPath = new URL('./jxl-wrapper-lab.html', import.meta.url);
const jsPath = new URL('./jxl-wrapper-lab.js', import.meta.url);

test('wrapper lab page is a separate page with three-way mode and 100-picture batch controls', () => {
    expect(existsSync(htmlPath)).toBe(true);
    expect(existsSync(jsPath)).toBe(true);

    const html = readFileSync(htmlPath, 'utf8');
    const js = readFileSync(jsPath, 'utf8');

    expect(html).toContain('JPEG XL wrapper lab');
    expect(html).toContain('data-mode="wrapper"');
    expect(html).toContain('data-mode="existing"');
    expect(html).toContain('data-mode="compare"');
    expect(html).toContain('wrapper-controls-btn');
    expect(html).toContain('batch-thumb-size');
    expect(html).toContain('id="batch-limit"');
    expect(html).toContain('id="run-batch"');
    expect(html).toContain('id="batch-grid"');
    expect(js).toContain('createEncoder');
    expect(js).toContain('createDecoder');
    expect(js).toContain('MAX_BATCH_LIMIT = 100');
    expect(js).toContain('wireSlideoutPanel');
});
