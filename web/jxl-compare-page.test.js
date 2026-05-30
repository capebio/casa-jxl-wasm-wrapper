import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';

const htmlPath = new URL('./jxl-compare.html', import.meta.url);
const jsPath = new URL('./jxl-wrapper-lab.js', import.meta.url);

test('compare page is a dedicated top-level page with compare controls', () => {
    expect(existsSync(htmlPath)).toBe(true);
    expect(existsSync(jsPath)).toBe(true);

    const html = readFileSync(htmlPath, 'utf8');
    const js = readFileSync(jsPath, 'utf8');

    expect(html).toContain('<title>JXL Compare</title>');
    expect(html).toContain('data-mode="compare"');
    expect(html).toContain('Session worker vs direct wrapper compare');
    expect(html).toContain('Original session stack vs optimized direct wrapper');
    expect(html).toContain('href="./jxl-wrapper-lab.html"');
    expect(html).toContain('href="./jxl-compare.html" aria-current="page"');
    expect(html).toContain('id="batch-concurrency"');
    expect(html).toContain('id="batch-quality"');
    expect(html).toContain('id="batch-effort"');
    expect(html).toContain('id="batch-limit"');
    expect(html).toContain('name="batch-thumb-size" value="128"');
    expect(html).toContain('name="batch-thumb-size" value="256" checked');
    expect(html).toContain('name="batch-thumb-size" value="512"');
    expect(html).toContain('name="batch-thumb-size" value="1024"');
    expect(html).toContain('name="batch-thumb-size" value="2048"');
    expect(html).toContain('name="batch-thumb-size" value="fullsize"');
    expect(html).toContain('id="batch-lossless"');
    expect(html).toContain('Statistics');
    expect(html).toContain('id="stats-existing-total"');
    expect(html).toContain('id="stats-wrapper-total"');
    expect(html).toContain('id="stats-total-delta"');
    expect(html).toContain('id="stats-wrapper-faster"');
    expect(html).toContain('Run compare');
    expect(js).toContain("setMode(document.body.dataset.mode || 'race');");
});
