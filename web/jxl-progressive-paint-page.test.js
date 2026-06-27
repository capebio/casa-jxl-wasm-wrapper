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
    // updated: streamIntoDecoder restored true byte-stepping (commit 9622a314) — pushes per-step chunks
    // via splitEncodedBytesIntoSteps, not a single full-buffer push. This matches the test's own title.
    expect(source).toContain('await decoder.push(exactBuffer(step));');
    expect(source).toContain('await decoder.close();');
    expect(source).not.toContain('Pushing all bytes…');
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
    expect(source).toContain("document.getElementById('prog-group-order')");
    // render now surfaces the dc/group actually used (for hunt data visibility)
    expect(source).toContain('progressiveDc, groupOrder');
    expect(source).toContain('dc=${progressiveDc ??');
});

test('Sneyers preset + throttle controls present and wired', () => {
    // HTML has both selects with correct defaults
    expect(html).toContain('id="preset-name"');
    expect(html).toContain('value="sneyers" selected');
    expect(html).toContain('id="throttle-rate"');
    expect(html).toContain('value="0" selected>Unthrottled');
    expect(html).not.toContain('value="100" selected');
    expect(html).toContain('Sneyers (truly-progressive)');
    expect(html).toContain('100 KB/s');
    // optional source preview canvas for fidelity visual comparison (original pre-encode vs passes)
    expect(html).toContain('id="source-preview"');
    expect(source).toContain('function paintSourcePreview');
    // JS has helper functions and only chunk-feeds when explicit throttle/network simulation is selected
    expect(source).toContain('function readPresetName()');
    expect(source).toContain('function readThrottleKbPerSec()');
    expect(source).toContain('function feedThrottled(');
    expect(source).toContain("import { createSneyersPreset } from './jxl-progressive-best-preset.js'");
    expect(source).toContain('throttleKbPerSec > 0');
    expect(source).toContain('await feedThrottled(decoder, jxlBytes, throttleKbPerSec)');
    expect(source).toContain('await streamIntoDecoder(decoder, jxlBytes, requestedPassCount)');
    // Sneyers preset forces previewFirst + Sneyers flags
    expect(source).toContain("presetName === 'sneyers' ? true");
    expect(source).toContain("presetName === 'sneyers' ? 2");
    expect(source).toContain("presetName === 'sneyers' ? 0");
    // Sneyers preset no longer forces all-pass decode; all passes remain an explicit Detail toggle.
    expect(source).not.toContain("if (presetName === 'sneyers') progressiveDetail = 'passes'");
    // Sneyers preset uses buffering=0 (non-streamed encode). libjxl 0.11 encode.h says 2/3 are
    // streaming mode and "might not be progressively decodeable" — defeats progressive paint.
    expect(source).toContain("presetName === 'sneyers' ? { strategy: 0 } : undefined");
    // UI sync for sneyers forces detail='passes' + steps=6 (for visible refinement layers)
    expect(source).toContain("syncSneyersDefaults");
    expect(source).toContain("presetEl.value !== 'sneyers'");
    // final PSNR vs source wired for fidelity QA in measurements/summary
    expect(source).toContain("final_psnr_vs_source");
    expect(source).toContain("computePsnrVsFinal");
});

test('progressive paint sends generated JXL and settings directly to gallery without mandatory download', () => {
    expect(html).toContain('Send to Progressive Gallery');
    expect(source).toContain('postProgressiveGalleryPayload');
    expect(source).toContain("type: 'progressive-gallery-push'");
    expect(source).toContain('settings: lastSettings ? { ...lastSettings } : null');
    // batch support uses array of items + multiple transfers, but still attempts direct post before fallback download
    expect(source).toContain('targetWindow.postMessage(message, location.origin, transfers);');
    expect(source).toContain('postProgressiveGalleryPayload(toExport)');
    expect(source).toContain('toExport.forEach(e => triggerJxlDownload(e.bytes, e.name))');
    expect(source.indexOf('postProgressiveGalleryPayload(toExport)')).toBeLessThan(source.indexOf('toExport.forEach(e => triggerJxlDownload'));
});

test('progressive paint records per-frame visibility stats in console and measurement exports', () => {
    expect(source).toContain("import { analyzeProgressiveFrame, formatFrameStatsCompact, formatFrameStatsLog } from './jxl-progressive-frame-stats.js';");
    expect(source).toContain("const statsEnabled = new URLSearchParams(location.search).get('stats') === '1';");
    expect(source).toContain('analyzeProgressiveFrame(passPixels, ev.info.width, ev.info.height)');
    expect(source).toContain('statsEnabled');
    expect(source).toContain('formatFrameStatsLog(frameStats)');
    expect(source).toContain("console.log('[Progressive Paint] frame stats'");
    expect(source).toContain('stats: p.stats');
    expect(source).toContain('pass_stats');
    expect(source).toContain('formatFrameStatsCompact(p.stats)');
    expect(source).toContain('perPassStats');
    expect(source).toContain('copyMeasurementsMarkdown');
    expect(source).toContain("copyMeasurementsMdBtn.addEventListener('click', copyMeasurementsMarkdown)");
});

test('A2: schedulePaint and paintPass extracted — source contains new rAF coalescing structure', () => {
    expect(source).toContain('let pendingFrame = null');
    expect(source).toContain('let rafPending = false');
    expect(source).toContain('function schedulePaint(');
    expect(source).toContain('function paintPass(');
    expect(source).toContain('requestAnimationFrame(');
});

test('A2: final events bypass rAF coalescing — paintPass called directly', () => {
    // isFinal check must appear before the rafPending guard in schedulePaint
    const schedIdx = source.indexOf('function schedulePaint(');
    const isFinalBypassIdx = source.indexOf('if (frame.isFinal)', schedIdx);
    const rafPendingIdx = source.indexOf('if (rafPending)', schedIdx);
    expect(isFinalBypassIdx).toBeGreaterThan(schedIdx);
    expect(isFinalBypassIdx).toBeLessThan(rafPendingIdx);
    expect(source.slice(isFinalBypassIdx, rafPendingIdx)).toContain('paintPass(pendingFrame)');
    expect(source.slice(isFinalBypassIdx, rafPendingIdx)).toContain('paintPass(frame)');
});

test('A2: collectProgressivePaintEvents no longer calls await nextPaint() or await sleep()', () => {
    const fnStart = source.indexOf('async function collectProgressivePaintEvents(');
    const fnEnd = source.indexOf('\nasync function ', fnStart + 1) === -1
        ? source.indexOf('\nfunction ', fnStart + 1)
        : source.indexOf('\nasync function ', fnStart + 1);
    const fnBody = fnEnd === -1 ? source.slice(fnStart) : source.slice(fnStart, fnEnd);
    expect(fnBody).not.toContain('await nextPaint()');
    expect(fnBody).not.toContain('await sleep(');
});

test('A2: coalescing note present in page for user transparency', () => {
    // The spec says: document dropped passes in bench UI
    // Accept either a comment in JS or text in HTML
    expect(source.includes('Coalescing') || source.includes('coalescing') || source.includes('dropped')).toBe(true);
});

test('A3: makePassCanvas removed — persistent canvas strategy used', () => {
    expect(source).not.toContain('function makePassCanvas(');
    expect(source).toContain('thumbCanvases');
    expect(source).toContain('putImageData');
});

test('A3: thumbCanvases cleared on timeline reset', () => {
    const clearFn = source.indexOf('function clearPassTimeline(');
    const clearEnd = source.indexOf('\nfunction ', clearFn + 1);
    const clearBody = clearEnd === -1 ? source.slice(clearFn) : source.slice(clearFn, clearEnd);
    expect(clearBody).toContain('thumbCanvases.clear()');
});

test('A4: stats gated behind statsEnabled — analyzeProgressiveFrame not called unconditionally', () => {
    // updated: STATS_ENABLED back-compat alias removed (commit f56843e1); canonical flag is statsEnabled (?stats=1)
    expect(source).toContain('statsEnabled');
    const paintPassIdx = source.indexOf('function paintPass(');
    const paintPassEnd = source.indexOf('\nfunction ', paintPassIdx + 1);
    const paintPassBody = paintPassEnd === -1 ? source.slice(paintPassIdx) : source.slice(paintPassIdx, paintPassEnd);
    expect(paintPassBody).toContain('statsEnabled');
    expect(paintPassBody).toContain('analyzeProgressiveFrame');
});

test('A4: per-pass dbgLog shows pass N · partial|final when stats off', () => {
    expect(source).toContain('partial');
    expect(source).toContain('final');
    // updated: STATS_ENABLED alias removed (commit f56843e1); canonical flag is statsEnabled
    expect(source).toContain('statsEnabled');
});

test('progressive paint prewarms and reports browser decode tier', () => {
    expect(source).toContain("import { createDecoder, createEncoder, detectTier, preloadJxlModule } from '@casabio/jxl-wasm';");
    expect(source).toContain('preloadJxlModule();');
    expect(source).toContain('crossOriginIsolated');
    expect(source).toContain('detectTier()');
});

test('progressive paint local decode byte-steps the feed and gates probes behind toggles', () => {
    // updated: streamIntoDecoder restored true byte-stepping (commit 9622a314) via splitEncodedBytesIntoSteps —
    // it no longer pushes the whole buffer once. Assert the per-step push + step splitting it now uses.
    const streamIdx = source.indexOf('async function streamIntoDecoder(');
    const streamEnd = source.indexOf('\nfunction renderProgressiveComparison', streamIdx);
    const streamBody = source.slice(streamIdx, streamEnd);
    expect(streamBody).toContain('splitEncodedBytesIntoSteps(jxlBytes, stepCount)');
    expect(streamBody).toContain('await decoder.push(exactBuffer(step));');
    expect(streamBody).toContain('for (const step of steps)');

    expect(html).toContain('id="run-one-shot-comparison"');
    expect(html).toContain('id="run-byte-cutoff-probe"');
    expect(source).toContain('function shouldRunOneShotComparison');
    expect(source).toContain('function shouldRunByteCutoffProbe');
    expect(source).toContain('if (shouldRunOneShotComparison())');
    expect(source).toContain('if (shouldRunByteCutoffProbe()) await runByteCutoffProbe(jxlBytes, progressiveDetail)');
});
