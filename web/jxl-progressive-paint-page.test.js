import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./jxl-progressive-paint.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('./jxl-progressive-paint.js', import.meta.url), 'utf8');

test('progressive paint page exposes requested pass-step controls and compare guidance', () => {
    expect(html).toContain('name="prog-passes"');
    expect(html).toContain('Stream steps:');
    expect(html).toContain('value="2"');
    expect(html).toContain('value="4"');
    expect(html).toContain('value="6"');
    expect(html).toContain('value="8"');
    expect(html).toContain('Actual paints can be lower than requested steps');
    expect(html).toContain('Click tiles in the strip below to pin actual paints into the viewers above.');
});

test('progressive paint reports requested stream steps separately from actual paints', () => {
    expect(source).toContain('streamStepsRequested: requestedPassCount');
    expect(source).toContain('paintsReceived: passes.length');
    expect(source).toContain('actual paints');
    expect(source).toContain('actualPaintWarning');
});

test('progressive paint exposes byte cutoff ladder for network-style progressive probing', () => {
    expect(html).toContain('id="byte-cutoff-ladder"');
    expect(html).toContain('Byte cutoff ladder');
    expect(source).toContain("import { buildByteCutoffPlan, formatByteCutoffLabel } from './jxl-byte-cutoff-probe.js';");
    expect(source).toContain('runByteCutoffProbe(jxlBytes, progressiveDetail)');
    expect(source).toContain('renderByteCutoffTile');
    expect(source).toContain('no paint');
});

test('progressive paint page streams encoder chunks into decoder instead of pushing full bytes before decode loop', () => {
    expect(source).toContain('for await (const chunk of encoder.chunks())');
    expect(source).toContain('await streamIntoDecoder(decoder, jxlBytes, requestedPassCount);');
    expect(source).toContain('Streaming bytes…');
    expect(source).toContain('await decoder.push(exactBuffer(stepChunk));');
    expect(source).toContain('await decoder.close();');
    expect(source).not.toContain('Pushing all bytes…');
    expect(source).not.toContain('decoder.push(jxlBytes);');
    expect(source).toContain('rebuild jxl-wasm to enable true chunk streaming');
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

test('progressive paint page exposes progressiveDetail selector with auto/dc/lastPasses/passes options', () => {
    expect(html).toContain('name="prog-detail"');
    expect(html).toContain('value="auto"');
    expect(html).toContain('value="dc"');
    expect(html).toContain('value="lastPasses"');
    expect(html).toContain('value="passes"');
});

test('progressive paint JS reads detail selector and applies auto-detection or manual selection', () => {
    expect(source).toContain('input[name="prog-detail"]:checked');
    expect(source).toContain("detailChoice === 'auto'");
    expect(source).toContain('getRequestedProgressiveDetail(requestedPassCount)');
    expect(source).toContain(": detailChoice;");
});

test('progressive paint exposes group-order center-out checkbox (UI polish for A/B + defaults) and wires it + render metadata', () => {
    expect(html).toContain('id="prog-group-order"');
    expect(html).toContain('Center-out');
    expect(html).toContain('data-help-target="pp-group"');
    expect(source).toContain('prog-group-order');
    expect(source).toContain('syncGroupOrderDefault');
    expect(source).toContain('groupOrder = !!(document.getElementById');
    // render now surfaces the dc/group actually used (for hunt data visibility)
    expect(source).toContain('progressiveDc, groupOrder');
    expect(source).toContain('dc=${progressiveDc ??');
});

test('progressive paint sends generated JXL and settings directly to gallery without mandatory download', () => {
    expect(html).toContain('Send to Progressive Gallery');
    expect(source).toContain('postProgressiveGalleryPayload');
    expect(source).toContain("type: 'progressive-gallery-push'");
    expect(source).toContain('settings: lastSettings ? { ...lastSettings } : null');
    expect(source).toContain('targetWindow.postMessage(message, location.origin, [payload.bytes.buffer]);');
    expect(source.indexOf('postProgressiveGalleryPayload')).toBeLessThan(source.indexOf('triggerJxlDownload(lastJxlBytes, name);'));
});
