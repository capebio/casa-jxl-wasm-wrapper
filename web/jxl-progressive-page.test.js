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

test('progressive page paints a source preview before encode/decode awaits', () => {
    const previewCall = 'paintPreparedPreview(card, source, rgba, targetDims);';
    const previewIndex = source.indexOf(previewCall);
    const encodeIndex = source.indexOf('const encodeResult = await encodeJxlWithSession');

    expect(source).toContain('const INITIAL_PREVIEW_LONG_EDGE');
    expect(previewIndex).toBeGreaterThan(-1);
    expect(previewIndex).toBeLessThan(encodeIndex);
});

test('thumb bench shows immediate running state before source loading', () => {
    expect(source).toContain("card.log.textContent = 'Loading sources...';");
    expect(source).toContain('await nextPaint();');
    expect(source).toContain('clearThumbBenchCard(card);');
});

test('progressive page wires shared console and logs encode/decode pipeline', () => {
    expect(source).toContain("import { initDebugConsole, dbgLog } from './jxl-debug-console.js';");
    expect(source).toContain('initDebugConsole(dbgConsoleBtn)');
    expect(source).toContain("dbgLog('▶ source load → /api/random-gobabeb')");
    expect(source).toContain("dbgLog(`  encode → ${target.label}`");
    expect(source).toContain("dbgLog(`  decode ← ${target.label}`");
});
