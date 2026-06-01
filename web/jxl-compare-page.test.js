import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';

const htmlPath = new URL('./jxl-compare.html', import.meta.url);
const jsPath = new URL('./jxl-compare.js', import.meta.url);

test('compare page is a dedicated top-level page with compare controls', () => {
    expect(existsSync(htmlPath)).toBe(true);
    expect(existsSync(jsPath)).toBe(true);

    const html = readFileSync(htmlPath, 'utf8');
    const js = readFileSync(jsPath, 'utf8');

    expect(html).toContain('<title>Format Race');
    expect(html).toContain('JXL vs JPEG vs WebP');
    expect(html).toContain('href="./jxl-wrapper-lab.html"');
    expect(html).toContain('href="./jxl-compare.html" aria-current="page"');
    expect(html).toContain('id="run-btn"');
    expect(html).toContain('id="reset-btn"');
    expect(html).toContain('name="quality-tier"');
    expect(html).toContain('name="effort"');
    expect(html).toContain('id="compare-results"');
    expect(html).toContain('id="lightbox"');
    expect(html).toContain('Load &amp; run race');
    expect(js).toContain("const runBtn");
    expect(js).toContain("function getTier()");
    expect(js).toContain("function getEffort()");
    expect(js).toContain("function openLightbox(");
});
