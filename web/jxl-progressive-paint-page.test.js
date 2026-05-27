import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./jxl-progressive-paint.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('./jxl-progressive-paint.js', import.meta.url), 'utf8');

test('progressive paint page exposes requested pass-step controls and compare guidance', () => {
    expect(html).toContain('name="prog-passes"');
    expect(html).toContain('value="2"');
    expect(html).toContain('value="4"');
    expect(html).toContain('value="6"');
    expect(html).toContain('value="8"');
    expect(html).toContain('Click pass tiles to pin them into the large compare slots above.');
});

test('progressive paint page streams encoder chunks into decoder instead of pushing full bytes before decode loop', () => {
    expect(source).toContain('for await (const chunk of encoder.chunks())');
    expect(source).toContain('await decoder.push(exactBuffer(stepChunk));');
    expect(source).toContain('await decoder.close();');
    expect(source).not.toContain('decoder.push(jxlBytes);');
    expect(source).not.toContain('decoder.close();\n\n        const decStart = performance.now();');
});

test('progressive paint one-shot comparison starts timer before push/close so timings include decode setup work', () => {
    expect(source).toContain('const oneShotStart = performance.now();');
    expect(source).toContain('await decoder2.push(jxlBytes);');
    expect(source.indexOf('const oneShotStart = performance.now();')).toBeLessThan(source.indexOf('await decoder2.push(jxlBytes);'));
});

test('progressive paint timeline thumbs are clickable compare targets', () => {
    expect(source).toContain("wrap.type = 'button';");
    expect(source).toContain('assignPassToCompareSlot(');
    expect(source).toContain('advanceCompareSlotCursor(');
});

test('progressive paint page exposes progressiveDetail selector with auto/dc/lastPasses/passes/dcProgressive options', () => {
    expect(html).toContain('name="prog-detail"');
    expect(html).toContain('value="auto"');
    expect(html).toContain('value="dc"');
    expect(html).toContain('value="lastPasses"');
    expect(html).toContain('value="passes"');
    expect(html).toContain('value="dcProgressive"');
});

test('progressive paint JS reads detail selector and applies auto-detection or manual selection', () => {
    expect(source).toContain('input[name="prog-detail"]:checked');
    expect(source).toContain("detailChoice === 'auto'");
    expect(source).toContain('getRequestedProgressiveDetail(requestedPassCount)');
    expect(source).toContain(": detailChoice;");
});
